//! A real text-analysis backend for the official Harness tool registry.
//! The embedding facade mounts this factory in its existing NativeDriver graph.
use cordis_node::{
    plugin::{
        FactoryDescriptor, FactoryRegistry, MethodDescriptor, MethodKind, PluginContext,
        PluginFactory, PluginFuture, PluginInstance, PluginResult, ServiceDescriptor,
    },
    NativeDriver,
};
use napi_derive::napi;
use serde_json::{json, Value};
use std::sync::Arc;

const FACTORY: &str = "harness.text-analysis";
const SERVICE: &str = "rustTextAnalysis";
const MAX_TEXT_BYTES: usize = 1_048_576;

struct TextAnalysisFactory;
struct TextAnalysis;

impl PluginFactory for TextAnalysisFactory {
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
            return Err("text-analysis config must be null or an empty object".into());
        }
        Ok(Arc::new(TextAnalysis))
    }
}

impl PluginInstance for TextAnalysis {
    fn setup(&self, ctx: PluginContext) -> PluginFuture {
        Box::pin(async move {
            ctx.provide(SERVICE).await?;
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
        let valid_method = service == SERVICE && method == "analyze";
        Box::pin(async move {
            ctx.cancellation().check()?;
            if !valid_method {
                return Err("unknown text-analysis method".into());
            }
            let text = match args.as_array().map(Vec::as_slice) {
                Some([Value::String(text)]) => text,
                _ => return Err("analyze requires exactly one string argument".into()),
            };
            analyze(text)
        })
    }
}

fn analyze(text: &str) -> PluginResult<Value> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!("text exceeds {MAX_TEXT_BYTES} UTF-8 bytes"));
    }
    // Bounded CPU work; no filesystem, network, background task or hidden host.
    // Characters are Unicode scalar values, not grapheme clusters.
    Ok(json!({
        "backend": "rust",
        "version": env!("CARGO_PKG_VERSION"),
        "bytes": text.len(),
        "characters": text.chars().count(),
        "lines": text.lines().count(),
        "words": text.split_whitespace().count(),
    }))
}

#[napi]
pub fn create_driver() -> napi::Result<NativeDriver> {
    let mut registry = FactoryRegistry::new();
    registry
        .register(TextAnalysisFactory)
        .map_err(napi::Error::from_reason)?;
    NativeDriver::with_factories(registry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_and_line_endings_have_explicit_counts() {
        let result = analyze("Hello 世界\r\nRust 🦀\n").unwrap();
        assert_eq!(result["bytes"], 24);
        assert_eq!(result["characters"], 17);
        assert_eq!(result["lines"], 2);
        assert_eq!(result["words"], 4);
        assert_eq!(analyze("").unwrap()["lines"], 0);
    }

    #[test]
    fn byte_limit_is_checked_before_processing() {
        assert!(analyze(&"x".repeat(MAX_TEXT_BYTES)).is_ok());
        assert!(analyze(&"x".repeat(MAX_TEXT_BYTES + 1)).is_err());
        assert!(analyze(&"界".repeat(MAX_TEXT_BYTES / 3 + 1)).is_err());
    }
}
