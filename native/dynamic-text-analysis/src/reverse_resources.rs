//! The JS provider owns the source and sink. This Rust action holds scoped
//! capabilities, validates every chunk/result, and never buffers all chunks.
use super::{yield_once, MAX_TEXT_BYTES};
use cordis_plugin_api::{
    FactoryDescriptor, MethodDescriptor, MethodKind, ObjectOwnership, PluginContext, PluginFactory,
    PluginFuture, PluginInstance, PluginResult, ServiceDescriptor,
};
use serde_json::{json, Value};
use std::sync::Arc;

pub const FACTORY: &str = "harness.dynamic-js-text-pipeline";
pub const SERVICE: &str = "rustJsTextPipeline";
pub const DEPENDENCY: &str = "textPipeline";
const MAX_CHUNK_CHARACTERS: usize = 4096;

pub struct PipelineFactory {
    pub revision: &'static str,
    pub failing: bool,
}
impl PluginFactory for PipelineFactory {
    fn descriptor(&self) -> FactoryDescriptor {
        FactoryDescriptor {
            name: FACTORY.into(),
            inject: vec![DEPENDENCY.into()],
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
            return Err("JS text pipeline config must be null or an empty object".into());
        }
        Ok(Arc::new(Pipeline {
            revision: self.revision,
            failing: self.failing,
        }))
    }
}
struct Pipeline {
    revision: &'static str,
    failing: bool,
}
impl PluginInstance for Pipeline {
    fn setup(&self, ctx: PluginContext) -> PluginFuture {
        let revision = self.revision;
        let failing = self.failing;
        Box::pin(async move {
            yield_once().await;
            if failing {
                return Err("DynamicTextCandidateSetupFailed".into());
            }
            ctx.call(DEPENDENCY, "lifecycle", json!(["setup", revision]))
                .await?;
            Ok(Value::Null)
        })
    }
    fn cleanup(&self, ctx: PluginContext) -> PluginFuture {
        let revision = self.revision;
        Box::pin(async move {
            ctx.call(DEPENDENCY, "lifecycle", json!(["cleanup", revision]))
                .await?;
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
                return Err("UnknownJsTextPipelineMethod".into());
            }
            let (text, chunk_characters) = arguments(args)?;
            let policy = ctx.open_object(DEPENDENCY, "policy", json!([])).await?;
            let policy_result = async {
                if policy.descriptor().ownership() != ObjectOwnership::Borrowed {
                    return Err("textPipeline.policy must return a borrowed object".into());
                }
                validate_policy(policy.call("snapshot", json!([])).await?)
            }
            .await;
            let provider_revision = finish(policy_result, [policy.close().await])?;
            // Move the input into the single opening request. The consumer keeps
            // only running sizes while the provider pulls bounded chunks.
            let expected_bytes = text.len();
            let stream = ctx
                .open_stream(
                    DEPENDENCY,
                    "chunks",
                    Value::Array(vec![Value::String(text), json!(chunk_characters)]),
                )
                .await?;
            let session = ctx.open_object(DEPENDENCY, "session", json!([])).await?;
            let result = async {
                if session.descriptor().ownership() != ObjectOwnership::Owned {
                    return Err("textPipeline.session must return an owned object".into());
                }
                let mut progress = Progress::default();
                while let Some(chunk) = stream.next().await? {
                    ctx.cancellation.check()?;
                    let text = progress.accept(&chunk, chunk_characters)?;
                    session.call("append", json!([text])).await?;
                }
                ctx.cancellation.check()?;
                if progress.bytes != expected_bytes {
                    return Err("JS text stream ended before consuming the complete input".into());
                }
                let snapshot = session.call("snapshot", json!([])).await?;
                ctx.cancellation.check()?;
                progress.result(revision, &provider_revision, snapshot)
            }
            .await;
            // Try both releases even if the body or first close failed. If an
            // earlier acquisition failed, the action journal still owns it.
            let object_close = session.close().await;
            let stream_close = stream.close().await;
            finish(result, [object_close, stream_close])
        })
    }
}
fn arguments(args: Value) -> PluginResult<(String, usize)> {
    let Value::Array(args) = args else {
        return Err("analyze requires text and chunkCharacters".into());
    };
    if args.len() != 2 {
        return Err("analyze requires exactly text and chunkCharacters".into());
    }
    let mut args = args.into_iter();
    let Some(Value::String(text)) = args.next() else {
        return Err("text must be a string".into());
    };
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!("text exceeds {MAX_TEXT_BYTES} UTF-8 bytes"));
    }
    let size = args
        .next()
        .and_then(|value| value.as_u64())
        .filter(|size| (1..=MAX_CHUNK_CHARACTERS as u64).contains(size))
        .ok_or("chunkCharacters must be an integer from 1 through 4096")?;
    Ok((text, size as usize))
}
fn validate_policy(value: Value) -> PluginResult<String> {
    if value["maxTextBytes"].as_u64() != Some(MAX_TEXT_BYTES as u64)
        || value["maxChunkCharacters"].as_u64() != Some(MAX_CHUNK_CHARACTERS as u64)
    {
        return Err("Unsupported JS text policy limits".into());
    }
    value["providerRevision"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 400)
        .map(str::to_owned)
        .ok_or_else(|| "Invalid JS text provider revision".into())
}
fn finish<T>(
    result: PluginResult<T>,
    closes: impl IntoIterator<Item = PluginResult<()>>,
) -> PluginResult<T> {
    let errors = closes
        .into_iter()
        .filter_map(Result::err)
        .collect::<Vec<_>>();
    if errors.is_empty() {
        return result;
    }
    let cleanup = format!("JS text resource close failed: {}", errors.join("; "));
    match result {
        Ok(_) => Err(cleanup),
        Err(error) => Err(format!("{error}; {cleanup}")),
    }
}
#[derive(Default)]
struct Progress {
    bytes: usize,
    characters: usize,
    chunks: usize,
}
impl Progress {
    fn accept<'a>(&mut self, value: &'a Value, limit: usize) -> PluginResult<&'a str> {
        let text = value["text"]
            .as_str()
            .filter(|text| !text.is_empty())
            .ok_or("Invalid JS text chunk")?;
        let characters = text.chars().count();
        if value["offsetBytes"].as_u64() != Some(self.bytes as u64)
            || characters > limit
            || text.len() > MAX_TEXT_BYTES - self.bytes
        {
            return Err("JS text chunk exceeds its declared bounds or offset".into());
        }
        self.bytes += text.len();
        self.characters += characters;
        self.chunks += 1;
        Ok(text)
    }
    fn result(&self, revision: &str, provider_revision: &str, value: Value) -> PluginResult<Value> {
        if value["providerRevision"].as_str() != Some(provider_revision)
            || value["bytes"].as_u64() != Some(self.bytes as u64)
            || value["characters"].as_u64() != Some(self.characters as u64)
            || value["chunks"].as_u64() != Some(self.chunks as u64)
        {
            return Err("JS text session snapshot does not match the consumed stream".into());
        }
        let words = value["words"]
            .as_u64()
            .filter(|count| *count <= self.characters as u64)
            .ok_or("Invalid JS text word count")?;
        let lines = value["lines"]
            .as_u64()
            .filter(|count| *count <= self.characters as u64)
            .ok_or("Invalid JS text line count")?;
        Ok(
            json!({"backend":"rust-js-resources", "revision":revision, "providerRevision":provider_revision,
            "bytes":self.bytes, "characters":self.characters, "words":words, "lines":lines, "chunks":self.chunks}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_requests_and_policy_metadata() {
        for value in [
            json!([]),
            json!(["text", 0]),
            json!(["text", 4097]),
            json!(["text", 1.2]),
            json!(["x".repeat(MAX_TEXT_BYTES + 1), 1]),
        ] {
            assert!(arguments(value).is_err());
        }
        assert_eq!(arguments(json!(["世界", 1])).unwrap(), ("世界".into(), 1));
        assert_eq!(validate_policy(json!({"providerRevision":"js-v1","maxTextBytes":MAX_TEXT_BYTES,"maxChunkCharacters":4096})).unwrap(), "js-v1");
        assert!(validate_policy(json!({"providerRevision":"v1"})).is_err());
        assert!(validate_policy(json!({"providerRevision":"界".repeat(100),"maxTextBytes":MAX_TEXT_BYTES,"maxChunkCharacters":4096})).is_ok());
    }
    #[test]
    fn validates_stream_offsets_and_unicode_scalar_limits_without_retaining_text() {
        let mut progress = Progress::default();
        progress
            .accept(&json!({"text":"A世","offsetBytes":0}), 2)
            .unwrap();
        assert!(progress
            .accept(&json!({"text":"界","offsetBytes":2}), 2)
            .is_err());
        assert!(progress
            .accept(&json!({"text":"界🦀","offsetBytes":4}), 1)
            .is_err());
        progress
            .accept(&json!({"text":"界🦀","offsetBytes":4}), 2)
            .unwrap();
        assert_eq!(
            (progress.bytes, progress.characters, progress.chunks),
            (11, 4, 2)
        );
    }
    #[test]
    fn bounds_total_chunks_and_rejects_inconsistent_sink_snapshots() {
        let mut progress = Progress::default();
        progress
            .accept(
                &json!({"text":"x".repeat(MAX_TEXT_BYTES),"offsetBytes":0}),
                MAX_TEXT_BYTES,
            )
            .unwrap();
        assert!(progress
            .accept(&json!({"text":"x","offsetBytes":MAX_TEXT_BYTES}), 1)
            .is_err());
        let progress = Progress {
            bytes: 6,
            characters: 2,
            chunks: 1,
        };
        let value = json!({"providerRevision":"js-v1","bytes":6,"characters":2,"chunks":1,"words":1,"lines":1});
        assert_eq!(
            progress.result("v2", "js-v1", value.clone()).unwrap()["backend"],
            "rust-js-resources"
        );
        assert!(progress.result("v2", "other", value.clone()).is_err());
        for (key, replacement) in [
            ("bytes", json!(7)),
            ("characters", json!(3)),
            ("chunks", json!(2)),
            ("words", json!(3)),
            ("lines", json!(-1)),
        ] {
            let mut invalid = value.clone();
            invalid[key] = replacement;
            assert!(progress.result("v2", "js-v1", invalid).is_err());
        }
    }
    #[test]
    fn reports_body_and_each_cleanup_failure() {
        assert_eq!(finish(Ok(42), [Ok(())]).unwrap(), 42);
        let failure = finish::<Value>(
            Err("body".into()),
            [Err("object".into()), Err("stream".into())],
        )
        .unwrap_err();
        assert!(
            failure.contains("body") && failure.contains("object") && failure.contains("stream")
        );
    }
}
