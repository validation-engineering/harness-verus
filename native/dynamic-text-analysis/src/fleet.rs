//! Runtime factory publication. Every worker is a real owned provider child;
//! the manager stores capabilities, never a second service registry.
use super::{analyze, MAX_TEXT_BYTES};
use cordis_plugin_api::{
    Checkpoint, CheckpointSchema, ChildHandle, FactoryDescriptor, MethodDescriptor, MethodKind,
    PluginContext, PluginFactory, PluginFuture, PluginInstance, PluginResult, ServiceDescriptor,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

pub const FACTORY: &str = "harness.dynamic-text-fleet";
pub const SERVICE: &str = "rustTextFleet";
pub const DEPENDENCY: &str = "textFleetAudit";
const MAX_WORKERS: usize = 16;
const CHECKPOINT_SCHEMA: &str = "cordis-harness/text-fleet";

pub struct FleetFactory {
    pub revision: &'static str,
    pub failing: bool,
}
fn methods(names: &[&str]) -> Vec<MethodDescriptor> {
    names
        .iter()
        .map(|name| MethodDescriptor {
            name: (*name).into(),
            kind: MethodKind::Async,
        })
        .collect()
}
fn empty_config(config: &Value) -> PluginResult<()> {
    if config.is_null() || config.as_object().is_some_and(|value| value.is_empty()) {
        Ok(())
    } else {
        Err("Text fleet config must be null or an empty object".into())
    }
}
impl PluginFactory for FleetFactory {
    fn descriptor(&self) -> FactoryDescriptor {
        FactoryDescriptor {
            name: FACTORY.into(),
            inject: vec![DEPENDENCY.into()],
            services: vec![ServiceDescriptor {
                name: SERVICE.into(),
                methods: methods(&["create", "list", "remove", "ready", "resumeCatalog"]),
            }],
        }
    }
    fn checkpoint_schema(&self) -> Option<CheckpointSchema> {
        Some(checkpoint_schema(self.revision))
    }
    fn create(&self, config: Value) -> PluginResult<Arc<dyn PluginInstance>> {
        empty_config(&config)?;
        Ok(Arc::new(Fleet {
            revision: self.revision,
            failing: self.failing,
            workers: Arc::new(Mutex::new(BTreeMap::new())),
            catalog: Arc::new(Mutex::new(Catalog::default())),
        }))
    }
}
struct Entry {
    handle: Option<ChildHandle>,
    busy: bool,
}
type Workers = Arc<Mutex<BTreeMap<String, Entry>>>;
#[derive(Default)]
struct Catalog {
    names: BTreeSet<String>,
    seeded: bool,
    restored: bool,
}
struct Fleet {
    revision: &'static str,
    failing: bool,
    workers: Workers,
    catalog: Arc<Mutex<Catalog>>,
}
// A dropped/cancelled action also releases the per-name reservation. The
// actual handle remains reachable until its real child has been removed.
struct Reservation {
    workers: Workers,
    worker: String,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(entry) = self.workers.lock().unwrap().get_mut(&self.worker) {
            entry.busy = false;
        }
    }
}
fn worker_name(args: &Value) -> PluginResult<String> {
    let Some([Value::String(name)]) = args.as_array().map(Vec::as_slice) else {
        return Err("Worker operation requires exactly one name".into());
    };
    valid_name(name)?;
    Ok(name.clone())
}
fn valid_name(name: &str) -> PluginResult<()> {
    if name.is_empty()
        || name.len() > 32
        || !name.as_bytes()[0].is_ascii_lowercase()
        || !name
            .bytes()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'_')
    {
        return Err("worker must match [a-z][a-z0-9_]{0,31}".into());
    }
    Ok(())
}
fn service_name(worker: &str) -> String {
    format!("rustFleet_{worker}")
}
async fn audit(
    ctx: &PluginContext,
    kind: &str,
    revision: &str,
    worker: &str,
    bytes: usize,
) -> PluginResult<()> {
    ctx.call(DEPENDENCY, "record", json!([kind, revision, worker, bytes]))
        .await?;
    Ok(())
}
fn checkpoint_schema(revision: &str) -> CheckpointSchema {
    let version = if revision == "v1" { 1 } else { 2 };
    CheckpointSchema {
        schema: CHECKPOINT_SCHEMA.into(),
        version,
        accepts: if version == 1 { vec![1] } else { vec![1, 2] },
    }
}
fn restore_names(checkpoint: Checkpoint, revision: &str) -> PluginResult<BTreeSet<String>> {
    if !checkpoint_schema(revision).accepts(&checkpoint) {
        return Err("Unsupported fleet checkpoint schema/version".into());
    }
    let object = checkpoint
        .data
        .as_object()
        .ok_or("Fleet checkpoint must be an object")?;
    if object.len() != 1 {
        return Err("Fleet checkpoint only accepts workers".into());
    }
    let names = object
        .get("workers")
        .and_then(Value::as_array)
        .ok_or("Fleet checkpoint requires workers")?;
    if names.len() > MAX_WORKERS {
        return Err("Fleet checkpoint exceeds worker limit".into());
    }
    let mut result = BTreeSet::new();
    for name in names {
        let name = name
            .as_str()
            .ok_or("Fleet checkpoint worker must be a string")?;
        valid_name(name)?;
        if !result.insert(name.to_owned()) {
            return Err("Duplicate fleet checkpoint worker".into());
        }
    }
    Ok(result)
}
async fn publish_worker(
    ctx: &PluginContext,
    workers: &Workers,
    revision: &'static str,
    worker: String,
    wait_ready: bool,
) -> PluginResult<Value> {
    {
        let mut entries = workers.lock().unwrap();
        if entries.contains_key(&worker) {
            return Err(format!("Worker {worker} already exists"));
        }
        if entries.len() >= MAX_WORKERS {
            return Err(format!("Text fleet supports at most {MAX_WORKERS} workers"));
        }
        entries.insert(
            worker.clone(),
            Entry {
                handle: None,
                busy: true,
            },
        );
    }
    let _reservation = Reservation {
        workers: workers.clone(),
        worker: worker.clone(),
    };
    let handle = ctx
        .publish(
            WorkerFactory {
                revision,
                worker: worker.clone(),
            },
            json!({}),
        )
        .await?;
    workers.lock().unwrap().get_mut(&worker).unwrap().handle = Some(handle.clone());
    if wait_ready {
        handle.initialized(ctx).await?;
    }
    let status = handle.status(ctx).await?;
    Ok(
        json!({ "worker": worker, "service": service_name(&worker), "revision": revision, "status": status }),
    )
}
impl PluginInstance for Fleet {
    fn checkpoint(&self) -> PluginResult<Value> {
        // This is explicitly manager-owned logical state. ChildHandle values,
        // child memory, graph IDs and JS consumer Fibers are never serialized.
        let catalog = self.catalog.lock().unwrap();
        Ok(json!({ "workers": catalog.names.iter().collect::<Vec<_>>() }))
    }
    fn restore(&self, checkpoint: Checkpoint) -> PluginResult<()> {
        let names = restore_names(checkpoint, self.revision)?;
        let mut catalog = self.catalog.lock().unwrap();
        if catalog.seeded || !self.workers.lock().unwrap().is_empty() {
            return Err("Fleet restore requires a fresh instance".into());
        }
        *catalog = Catalog {
            names,
            seeded: true,
            restored: true,
        };
        Ok(())
    }
    fn setup(&self, ctx: PluginContext) -> PluginFuture {
        let (revision, failing) = (self.revision, self.failing);
        let workers = self.workers.clone();
        let restored = self
            .catalog
            .lock()
            .unwrap()
            .names
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        Box::pin(async move {
            if failing {
                return Err("DynamicTextCandidateSetupFailed".into());
            }
            audit(&ctx, "manager-setup", revision, "", 0).await?;
            for worker in restored {
                // Setup may await allocation, never readiness of its own anchor.
                publish_worker(&ctx, &workers, revision, worker, false).await?;
            }
            Ok(Value::Null)
        })
    }
    fn cleanup(&self, ctx: PluginContext) -> PluginFuture {
        let revision = self.revision;
        Box::pin(async move {
            // The host drains owned children before the manager's final inverse.
            audit(&ctx, "manager-cleanup", revision, "", 0).await?;
            Ok(Value::Null)
        })
    }
    fn call_async(
        &self,
        ctx: PluginContext,
        service: &str,
        method: &str,
        args: Value,
    ) -> PluginFuture {
        let valid = service == SERVICE;
        let method = method.to_owned();
        let workers = self.workers.clone();
        let catalog = self.catalog.clone();
        let revision = self.revision;
        Box::pin(async move {
            if !valid {
                return Err("UnknownTextFleetService".into());
            }
            match method.as_str() {
                "create" => {
                    let worker = worker_name(&args)?;
                    let value =
                        publish_worker(&ctx, &workers, revision, worker.clone(), true).await?;
                    catalog.lock().unwrap().names.insert(worker);
                    Ok(value)
                }
                "ready" => {
                    let worker = worker_name(&args)?;
                    let handle = workers
                        .lock()
                        .unwrap()
                        .get(&worker)
                        .and_then(|entry| entry.handle.clone())
                        .ok_or("Worker has no allocated child")?;
                    handle.initialized(&ctx).await?;
                    let status = handle.status(&ctx).await?;
                    Ok(
                        json!({ "worker": worker, "service": service_name(&worker), "revision": revision, "status": status }),
                    )
                }
                "resumeCatalog" => {
                    let Some([Value::Array(defaults)]) = args.as_array().map(Vec::as_slice) else {
                        return Err("resumeCatalog requires an initial worker array".into());
                    };
                    let defaults = restore_names(
                        Checkpoint {
                            schema: CHECKPOINT_SCHEMA.into(),
                            version: 1,
                            data: json!({ "workers": defaults }),
                        },
                        revision,
                    )?;
                    let mut catalog = catalog.lock().unwrap();
                    let seeded = catalog.seeded;
                    if !seeded {
                        catalog.names = defaults;
                        catalog.seeded = true;
                    }
                    let value = json!({ "restored": catalog.restored, "seeded": seeded, "workers": catalog.names.iter().collect::<Vec<_>>() });
                    catalog.restored = false;
                    Ok(value)
                }
                "list" => {
                    if args.as_array().is_none_or(|args| !args.is_empty()) {
                        return Err("list takes no arguments".into());
                    }
                    let entries: Vec<_> = workers
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|(worker, entry)| (worker.clone(), entry.handle.clone(), entry.busy))
                        .collect();
                    let mut values = Vec::with_capacity(entries.len());
                    for (worker, handle, busy) in entries {
                        let status = match handle {
                            Some(handle) => Some(handle.status(&ctx).await?),
                            None => None,
                        };
                        values.push(json!({ "worker": worker, "service": service_name(&worker), "busy": busy, "status": status }));
                    }
                    Ok(json!({ "revision": revision, "workers": values }))
                }
                "remove" => {
                    let worker = worker_name(&args)?;
                    let handle = {
                        let mut entries = workers.lock().unwrap();
                        let Some(entry) = entries.get_mut(&worker) else {
                            // Initial seeding can precede actual publication.
                            // Semantic removal must also forget an unallocated
                            // name, otherwise a later checkpoint resurrects it.
                            drop(entries);
                            catalog.lock().unwrap().names.remove(&worker);
                            return Ok(json!({ "worker": worker, "removed": true }));
                        };
                        if entry.busy {
                            return Err(format!("Worker {worker} operation in progress"));
                        }
                        entry.busy = true;
                        entry.handle.clone()
                    };
                    let _reservation = Reservation {
                        workers: workers.clone(),
                        worker: worker.clone(),
                    };
                    if let Some(handle) = handle {
                        let status = handle.status(&ctx).await?;
                        if !status.removed {
                            if status.cleanup_failed {
                                // A successful explicit retry already joins the
                                // real removal. A second ordinary join may still
                                // report the previously observed failure.
                                handle.retry_cleanup(&ctx).await?;
                            } else {
                                handle.dispose(&ctx).await?;
                                handle.join(&ctx).await?;
                            }
                        }
                        let status = handle.status(&ctx).await?;
                        if !status.removed || status.cleanup_failed {
                            return Err(
                                "Worker removal or native finalization is incomplete".into()
                            );
                        }
                    }
                    workers.lock().unwrap().remove(&worker);
                    catalog.lock().unwrap().names.remove(&worker);
                    Ok(json!({ "worker": worker, "removed": true }))
                }
                _ => Err("UnknownTextFleetMethod".into()),
            }
        })
    }
}
struct WorkerFactory {
    revision: &'static str,
    worker: String,
}
impl PluginFactory for WorkerFactory {
    fn descriptor(&self) -> FactoryDescriptor {
        FactoryDescriptor {
            name: format!("harness.text-worker.{}", self.worker),
            inject: vec![DEPENDENCY.into()],
            services: vec![ServiceDescriptor {
                name: service_name(&self.worker),
                methods: methods(&["analyze"]),
            }],
        }
    }
    fn create(&self, config: Value) -> PluginResult<Arc<dyn PluginInstance>> {
        empty_config(&config)?;
        Ok(Arc::new(Worker {
            revision: self.revision,
            worker: self.worker.clone(),
        }))
    }
}
struct Worker {
    revision: &'static str,
    worker: String,
}
impl PluginInstance for Worker {
    fn setup(&self, ctx: PluginContext) -> PluginFuture {
        let (revision, worker) = (self.revision, self.worker.clone());
        Box::pin(async move {
            audit(&ctx, "worker-setup", revision, &worker, 0).await?;
            Ok(Value::Null)
        })
    }
    fn cleanup(&self, ctx: PluginContext) -> PluginFuture {
        let (revision, worker) = (self.revision, self.worker.clone());
        Box::pin(async move {
            audit(&ctx, "worker-cleanup", revision, &worker, 0).await?;
            Ok(Value::Null)
        })
    }
    fn call_async(
        &self,
        ctx: PluginContext,
        service: &str,
        method: &str,
        args: Value,
    ) -> PluginFuture {
        let valid = service == service_name(&self.worker) && method == "analyze";
        let (revision, worker) = (self.revision, self.worker.clone());
        Box::pin(async move {
            if !valid {
                return Err("UnknownTextWorkerMethod".into());
            }
            let Some([Value::String(text)]) = args.as_array().map(Vec::as_slice) else {
                return Err("analyze requires exactly one string argument".into());
            };
            if text.len() > MAX_TEXT_BYTES {
                return Err(format!("text exceeds {MAX_TEXT_BYTES} UTF-8 bytes"));
            }
            audit(&ctx, "worker-analyze", revision, &worker, text.len()).await?;
            ctx.cancellation.check()?;
            let mut value = analyze(revision, text)?;
            value["backend"] = json!("rust-published-worker");
            value["worker"] = json!(worker);
            Ok(value)
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_checkpoint_restores_names_across_versions_without_handles_or_node_ids() {
        let instance = FleetFactory {
            revision: "v2",
            failing: false,
        }
        .create(json!({}))
        .unwrap();
        instance
            .restore(Checkpoint {
                schema: CHECKPOINT_SCHEMA.into(),
                version: 1,
                data: json!({"workers":["review", "notes"]}),
            })
            .unwrap();
        assert_eq!(
            instance.checkpoint().unwrap(),
            json!({"workers":["notes", "review"]})
        );
        assert_eq!(checkpoint_schema("v1").version, 1);
        assert_eq!(checkpoint_schema("v2").version, 2);
        assert_eq!(checkpoint_schema("v2").accepts, vec![1, 2]);
        let empty = FleetFactory {
            revision: "v2",
            failing: false,
        }
        .create(json!({}))
        .unwrap();
        empty
            .restore(Checkpoint {
                schema: CHECKPOINT_SCHEMA.into(),
                version: 1,
                data: json!({"workers":[]}),
            })
            .unwrap();
        assert_eq!(empty.checkpoint().unwrap(), json!({"workers":[]}));
    }
    #[test]
    fn checkpoint_validation_rejects_corruption_before_mutating_logical_state() {
        for data in [
            json!({}),
            json!({"workers":["notes", "notes"]}),
            json!({"workers":["bad-name"]}),
            json!({"workers":[42]}),
            json!({"workers":[], "handle":1}),
            json!({"workers":(0..17).map(|n|format!("w{n}")).collect::<Vec<_>>()}),
        ] {
            let instance = FleetFactory {
                revision: "v2",
                failing: false,
            }
            .create(json!({}))
            .unwrap();
            assert!(instance
                .restore(Checkpoint {
                    schema: CHECKPOINT_SCHEMA.into(),
                    version: 1,
                    data
                })
                .is_err());
            assert_eq!(instance.checkpoint().unwrap(), json!({"workers":[]}));
            // This unit calls the pure hook directly to inspect mutation.
            // The SDK rejects activation after a failed restore; no retry here.
        }
        for (schema, version) in [
            ("foreign", 1),
            (CHECKPOINT_SCHEMA, 0),
            (CHECKPOINT_SCHEMA, 3),
        ] {
            assert!(restore_names(
                Checkpoint {
                    schema: schema.into(),
                    version,
                    data: json!({"workers":[]})
                },
                "v2"
            )
            .is_err());
        }
        assert!(restore_names(
            Checkpoint {
                schema: CHECKPOINT_SCHEMA.into(),
                version: 2,
                data: json!({"workers":[]})
            },
            "v1"
        )
        .is_err());
    }
    #[test]
    fn removing_a_seeded_but_unpublished_name_does_not_resurrect_after_restore() {
        fn run(instance: &dyn PluginInstance, method: &str, args: Value) -> Value {
            // These two actual action branches need no host or asynchronous I/O.
            let mut action = instance.call_async(PluginContext::default(), SERVICE, method, args);
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            match action.as_mut().poll(&mut context) {
                std::task::Poll::Ready(result) => result.unwrap(),
                std::task::Poll::Pending => panic!("Expected a synchronous logical action"),
            }
        }
        let instance = FleetFactory {
            revision: "v1",
            failing: false,
        }
        .create(json!({}))
        .unwrap();
        assert_eq!(
            run(
                instance.as_ref(),
                "resumeCatalog",
                json!([["notes", "code"]])
            )["workers"],
            json!(["code", "notes"])
        );
        // No publication has occurred: remove must clear the logical seed even
        // though there is no entry in the actual ChildHandle map.
        assert_eq!(
            run(instance.as_ref(), "remove", json!(["code"])),
            json!({"worker":"code", "removed":true})
        );
        assert_eq!(
            run(instance.as_ref(), "remove", json!(["code"])),
            json!({"worker":"code", "removed":true})
        );
        let checkpoint = instance.checkpoint().unwrap();
        assert_eq!(checkpoint, json!({"workers":["notes"]}));
        let restored = FleetFactory {
            revision: "v2",
            failing: false,
        }
        .create(json!({}))
        .unwrap();
        restored
            .restore(Checkpoint {
                schema: CHECKPOINT_SCHEMA.into(),
                version: 1,
                data: checkpoint,
            })
            .unwrap();
        let resumed = run(
            restored.as_ref(),
            "resumeCatalog",
            json!([["notes", "code"]]),
        );
        assert_eq!(resumed["workers"], json!(["notes"]));
        assert_eq!(resumed["seeded"], true);
        assert_eq!(restored.checkpoint().unwrap(), json!({"workers":["notes"]}));
    }
    #[test]
    fn worker_names_are_bounded_unambiguous_service_and_tool_identifiers() {
        for name in ["notes", "code_2", &"a".repeat(32)] {
            valid_name(name).unwrap();
        }
        for name in ["", "A", "2a", "a.b", "a-b", "界", &"a".repeat(33)] {
            assert!(valid_name(name).is_err());
        }
        assert!(worker_name(&json!(["ok", "extra"])).is_err());
        assert!(worker_name(&json!([42])).is_err());
    }
    #[test]
    fn runtime_factory_declares_its_own_real_service_and_external_dependency() {
        let factory = WorkerFactory {
            revision: "v1",
            worker: "notes".into(),
        };
        let descriptor = factory.descriptor();
        assert_eq!(descriptor.services[0].name, "rustFleet_notes");
        assert_eq!(descriptor.inject, vec![DEPENDENCY]);
        let a = factory.create(json!({})).unwrap();
        let b = factory.create(json!({})).unwrap();
        assert!(
            !Arc::ptr_eq(&a, &b),
            "Each activation must receive a fresh instance"
        );
        assert!(factory.create(json!({"unknown":true})).is_err());
        assert_eq!(
            FleetFactory {
                revision: "v1",
                failing: false
            }
            .descriptor()
            .services
            .len(),
            1
        );
    }
}
