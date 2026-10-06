//! Independently built native plugin: only the stable SDK and JSON cross into
//! the resident Cordis host. This crate contains no Driver or Node binding.
use cordis_plugin_api::{
    FactoryDescriptor, MethodDescriptor, MethodKind, Module, PluginContext, PluginFactory,
    PluginFuture, PluginInstance, PluginResult, ServiceDescriptor,
};
mod fleet;
mod resources;
mod reverse_resources;

use serde_json::{json, Value};
use std::sync::Arc;
use std::task::Poll;

pub const FACTORY: &str = "harness.dynamic-text-analysis";
pub const SERVICE: &str = "rustDynamicText";
pub const POLICY_FACTORY: &str = "harness.dynamic-policy-text-analysis";
pub const POLICY_SERVICE: &str = "rustPolicyText";
pub const POLICY_DEPENDENCY: &str = "textPolicy";
// Leave room for JSON escaping and request metadata below the ABI's 1 MiB cap.
const MAX_TEXT_BYTES: usize = 128 * 1024;

pub fn module(revision: &'static str, failing: bool) -> Module {
    Module::new("harness.dynamic-text-analysis", revision)
        .factory(TextFactory {
            revision,
            failing,
            policy: false,
        })
        .factory(TextFactory {
            revision,
            failing,
            policy: true,
        })
        .factory(fleet::FleetFactory { revision, failing })
        .factory(resources::ResourceFactory { revision, failing })
        .factory(reverse_resources::PipelineFactory { revision, failing })
}
struct TextFactory {
    revision: &'static str,
    failing: bool,
    policy: bool,
}
struct TextAnalysis {
    revision: &'static str,
    failing: bool,
    policy: bool,
}
impl PluginFactory for TextFactory {
    fn descriptor(&self) -> FactoryDescriptor {
        FactoryDescriptor {
            name: if self.policy { POLICY_FACTORY } else { FACTORY }.into(),
            inject: if self.policy {
                vec![POLICY_DEPENDENCY.into()]
            } else {
                vec![]
            },
            services: vec![ServiceDescriptor {
                name: if self.policy { POLICY_SERVICE } else { SERVICE }.into(),
                methods: vec![MethodDescriptor {
                    name: "analyze".into(),
                    kind: MethodKind::Async,
                }],
            }],
        }
    }
    fn create(&self, config: Value) -> PluginResult<Arc<dyn PluginInstance>> {
        if !(config.is_null() || config.as_object().is_some_and(|value| value.is_empty())) {
            return Err("dynamic text-analysis config must be null or an empty object".into());
        }
        Ok(Arc::new(TextAnalysis {
            revision: self.revision,
            failing: self.failing,
            policy: self.policy,
        }))
    }
}
async fn yield_once() {
    let mut first = true;
    std::future::poll_fn(move |ctx| {
        if std::mem::take(&mut first) {
            ctx.waker().wake_by_ref();
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    })
    .await;
}
impl PluginInstance for TextAnalysis {
    fn setup(&self, ctx: PluginContext) -> PluginFuture {
        let failing = self.failing;
        let policy = self.policy;
        let revision = self.revision;
        Box::pin(async move {
            yield_once().await;
            if failing {
                return Err("DynamicTextCandidateSetupFailed".into());
            }
            if policy {
                ctx.call(POLICY_DEPENDENCY, "lifecycle", json!(["setup", revision]))
                    .await?;
            }
            Ok(Value::Null)
        })
    }
    fn cleanup(&self, ctx: PluginContext) -> PluginFuture {
        let policy = self.policy;
        let revision = self.revision;
        Box::pin(async move {
            yield_once().await;
            if policy {
                // Cleanup retains the dependency committed by this activation.
                ctx.call(POLICY_DEPENDENCY, "lifecycle", json!(["cleanup", revision]))
                    .await?;
            }
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
        let policy = self.policy;
        let valid = service == if policy { POLICY_SERVICE } else { SERVICE } && method == "analyze";
        let revision = self.revision;
        Box::pin(async move {
            if !valid {
                return Err("UnknownDynamicTextMethod".into());
            }
            yield_once().await;
            ctx.cancellation.check()?;
            let text = match args.as_array().map(Vec::as_slice) {
                Some([Value::String(text)]) => text,
                _ => return Err("analyze requires exactly one string argument".into()),
            };
            if !policy {
                return analyze(revision, text);
            }
            if text.len() > MAX_TEXT_BYTES {
                return Err(format!("text exceeds {MAX_TEXT_BYTES} UTF-8 bytes"));
            }
            let normalized = ctx
                .call(POLICY_DEPENDENCY, "normalize", json!([text]))
                .await?;
            ctx.cancellation.check()?;
            analyze_policy(revision, normalized)
        })
    }
}
fn analyze(revision: &str, text: &str) -> PluginResult<Value> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!("text exceeds {MAX_TEXT_BYTES} UTF-8 bytes"));
    }
    // Unicode scalar values, not grapheme clusters; Rust lines() recognizes LF
    // and CRLF and omits a trailing line terminator.
    Ok(json!({
        "backend": "rust-dynamic", "revision": revision,
        "bytes": text.len(), "characters": text.chars().count(),
        "lines": text.lines().count(), "words": text.split_whitespace().count(),
    }))
}
fn analyze_policy(revision: &str, normalized: Value) -> PluginResult<Value> {
    let text = normalized
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "textPolicy.normalize must return a string text".to_string())?;
    let policy = normalized
        .get("policyRevision")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .ok_or_else(|| {
            "textPolicy.normalize must return a nonempty policyRevision of at most 200 bytes"
                .to_string()
        })?;
    let mut result = analyze(revision, text)?;
    result["policyRevision"] = json!(policy);
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revisions_preserve_unicode_and_line_count_semantics() {
        for revision in ["v1", "v2"] {
            let value = analyze(revision, "Hello 世界\r\nRust 🦀\n").unwrap();
            assert_eq!(value["backend"], "rust-dynamic");
            assert_eq!(value["revision"], revision);
            assert_eq!(value["bytes"], 24);
            assert_eq!(value["characters"], 17);
            assert_eq!(value["lines"], 2);
            assert_eq!(value["words"], 4);
        }
        assert_eq!(analyze("v1", "").unwrap()["lines"], 0);
    }
    #[test]
    fn unicode_byte_limit_is_enforced() {
        assert!(analyze("v1", &"x".repeat(MAX_TEXT_BYTES)).is_ok());
        assert!(analyze("v1", &"x".repeat(MAX_TEXT_BYTES + 1)).is_err());
        assert!(analyze("v1", &"界".repeat(MAX_TEXT_BYTES / 3 + 1)).is_err());
    }
    #[test]
    fn policy_factory_declares_the_js_dependency_without_changing_the_default() {
        for policy in [false, true] {
            let descriptor = TextFactory {
                revision: "v1",
                failing: false,
                policy,
            }
            .descriptor();
            assert_eq!(
                descriptor.inject,
                if policy {
                    vec![POLICY_DEPENDENCY.to_string()]
                } else {
                    vec![]
                }
            );
            assert_eq!(
                descriptor.services[0].name,
                if policy { POLICY_SERVICE } else { SERVICE }
            );
        }
    }
    #[test]
    fn policy_results_validate_js_data_and_count_the_normalized_text() {
        let result = analyze_policy(
            "v1",
            json!({"text":"prefix 世界", "policyRevision":"policy-v2"}),
        )
        .unwrap();
        assert_eq!(result["bytes"], 13);
        assert_eq!(result["characters"], 9);
        assert_eq!(result["policyRevision"], "policy-v2");
        assert!(analyze_policy("v1", json!({"text":42, "policyRevision":"v1"})).is_err());
        assert!(analyze_policy("v1", json!({"text":"text", "policyRevision":""})).is_err());
        assert!(analyze_policy(
            "v1",
            json!({"text":"x".repeat(MAX_TEXT_BYTES + 1), "policyRevision":"v1"})
        )
        .is_err());
    }
    #[test]
    fn factories_reject_unused_configuration() {
        let factory = TextFactory {
            revision: "v1",
            failing: false,
            policy: false,
        };
        assert!(factory.create(Value::Null).is_ok());
        assert!(factory.create(json!({})).is_ok());
        assert!(factory.create(json!({"ignored":true})).is_err());
    }
}
