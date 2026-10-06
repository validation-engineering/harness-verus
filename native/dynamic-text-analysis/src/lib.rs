//! Independently built native plugin: only the stable SDK and JSON cross into
//! the resident Cordis host. This crate contains no Driver or Node binding.
use cordis_plugin_api::{
    FactoryDescriptor, MethodDescriptor, MethodKind, Module, PluginContext, PluginFactory,
    PluginFuture, PluginInstance, PluginResult, ServiceDescriptor,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::task::Poll;

pub const FACTORY: &str = "harness.dynamic-text-analysis";
pub const SERVICE: &str = "rustDynamicText";
// Leave room for JSON escaping and request metadata below the ABI's 1 MiB cap.
const MAX_TEXT_BYTES: usize = 128 * 1024;

pub fn module(revision: &'static str, failing: bool) -> Module {
    Module::new("harness.dynamic-text-analysis", revision)
        .factory(TextFactory { revision, failing })
}
struct TextFactory {
    revision: &'static str,
    failing: bool,
}
struct TextAnalysis {
    revision: &'static str,
    failing: bool,
}
impl PluginFactory for TextFactory {
    fn descriptor(&self) -> FactoryDescriptor {
        FactoryDescriptor {
            name: FACTORY.into(),
            inject: vec![],
            services: vec![ServiceDescriptor {
                name: SERVICE.into(),
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
    fn setup(&self, _ctx: PluginContext) -> PluginFuture {
        let failing = self.failing;
        Box::pin(async move {
            yield_once().await;
            if failing {
                Err("DynamicTextCandidateSetupFailed".into())
            } else {
                Ok(Value::Null)
            }
        })
    }
    fn cleanup(&self, _ctx: PluginContext) -> PluginFuture {
        Box::pin(async {
            yield_once().await;
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
        let valid = service == SERVICE && method == "analyze";
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
            analyze(revision, text)
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
    fn factories_reject_unused_configuration() {
        let factory = TextFactory {
            revision: "v1",
            failing: false,
        };
        assert!(factory.create(Value::Null).is_ok());
        assert!(factory.create(json!({})).is_ok());
        assert!(factory.create(json!({"ignored":true})).is_err());
    }
}
