//! Opt-in, Rust-owned resources. Only bounded JSON chunks and opaque identities
//! cross the library boundary; the cursor and analysis session remain here.
use super::{yield_once, MAX_TEXT_BYTES};
use cordis_plugin_api::{
    FactoryDescriptor, MethodDescriptor, MethodKind, ObjectDescriptor, ObjectOwnership,
    PluginContext, PluginFactory, PluginFuture, PluginInstance, PluginObject, PluginResult,
    PluginStream, ServiceDescriptor, StreamFuture,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub const FACTORY: &str = "harness.dynamic-text-resources";
pub const SERVICE: &str = "rustTextResources";
pub const AUDIT: &str = "textResourceAudit";
const MAX_CHUNK_CHARACTERS: usize = 4096;

pub struct ResourceFactory {
    pub revision: &'static str,
    pub failing: bool,
}
impl PluginFactory for ResourceFactory {
    fn descriptor(&self) -> FactoryDescriptor {
        FactoryDescriptor {
            name: FACTORY.into(),
            inject: vec![AUDIT.into()],
            services: vec![ServiceDescriptor {
                name: SERVICE.into(),
                methods: vec![
                    MethodDescriptor {
                        name: "chunks".into(),
                        kind: MethodKind::Stream,
                    },
                    MethodDescriptor {
                        name: "session".into(),
                        kind: MethodKind::Object,
                    },
                ],
            }],
        }
    }
    fn create(&self, config: Value) -> PluginResult<Arc<dyn PluginInstance>> {
        if !(config.is_null() || config.as_object().is_some_and(|value| value.is_empty())) {
            return Err("text resource config must be null or an empty object".into());
        }
        Ok(Arc::new(TextResources {
            revision: self.revision,
            failing: self.failing,
        }))
    }
}
struct TextResources {
    revision: &'static str,
    failing: bool,
}
async fn record(
    ctx: &PluginContext,
    kind: &str,
    revision: &str,
    details: Value,
) -> PluginResult<()> {
    ctx.call(AUDIT, "record", json!([kind, revision, details]))
        .await?;
    Ok(())
}
impl PluginInstance for TextResources {
    fn setup(&self, ctx: PluginContext) -> PluginFuture {
        let revision = self.revision;
        let failing = self.failing;
        Box::pin(async move {
            yield_once().await;
            if failing {
                return Err("DynamicTextCandidateSetupFailed".into());
            }
            record(&ctx, "native-setup", revision, json!({})).await?;
            Ok(Value::Null)
        })
    }
    fn cleanup(&self, ctx: PluginContext) -> PluginFuture {
        let revision = self.revision;
        Box::pin(async move {
            record(&ctx, "native-cleanup", revision, json!({})).await?;
            Ok(Value::Null)
        })
    }
    fn open_stream(
        &self,
        service: &str,
        method: &str,
        args: Value,
    ) -> PluginResult<Arc<dyn PluginStream>> {
        if service != SERVICE || method != "chunks" {
            return Err("UnknownTextResourceStream".into());
        }
        let (text, chunk_characters) = chunk_arguments(args)?;
        Ok(Arc::new(TextChunks {
            revision: self.revision,
            text: text.into(),
            chunk_characters,
            offset: Arc::new(Mutex::new(0)),
        }))
    }
    fn open_object(
        &self,
        service: &str,
        method: &str,
        args: Value,
    ) -> PluginResult<Arc<dyn PluginObject>> {
        if service != SERVICE || method != "session" {
            return Err("UnknownTextResourceObject".into());
        }
        if args.as_array().is_none_or(|args| !args.is_empty()) {
            return Err("session requires no arguments".into());
        }
        Ok(Arc::new(TextSession {
            revision: self.revision,
            descriptor: ObjectDescriptor::new(
                "TextAnalysisSession",
                ["append", "snapshot"],
                ObjectOwnership::Owned,
            )?,
            state: Arc::new(Mutex::new(SessionState::default())),
        }))
    }
}
fn chunk_arguments(args: Value) -> PluginResult<(String, usize)> {
    let args = args
        .as_array()
        .ok_or("chunks requires text and chunkCharacters")?;
    let [Value::String(text), size] = args.as_slice() else {
        return Err("chunks requires exactly one string and a chunkCharacters integer".into());
    };
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!("text exceeds {MAX_TEXT_BYTES} UTF-8 bytes"));
    }
    let size = size
        .as_u64()
        .filter(|n| (1..=MAX_CHUNK_CHARACTERS as u64).contains(n))
        .ok_or("chunkCharacters must be an integer from 1 through 4096")?;
    Ok((text.clone(), size as usize))
}
fn chunk_end(text: &str, offset: usize, characters: usize) -> usize {
    offset
        + text[offset..]
            .char_indices()
            .nth(characters)
            .map_or(text.len() - offset, |(index, _)| index)
}
struct TextChunks {
    revision: &'static str,
    text: Arc<str>,
    chunk_characters: usize,
    offset: Arc<Mutex<usize>>,
}
impl PluginStream for TextChunks {
    fn next(&self, ctx: PluginContext) -> StreamFuture {
        let revision = self.revision;
        let text = self.text.clone();
        let offset = self.offset.clone();
        let characters = self.chunk_characters;
        Box::pin(async move {
            yield_once().await;
            ctx.cancellation.check()?;
            let start = *offset.lock().map_err(|_| "TextCursorPoisoned")?;
            if start == text.len() {
                return Ok(None);
            }
            record(&ctx, "stream-pull", revision, json!({"offsetBytes": start})).await?;
            ctx.cancellation.check()?;
            let end = chunk_end(&text, start, characters);
            *offset.lock().map_err(|_| "TextCursorPoisoned")? = end;
            Ok(Some(
                json!({"text": &text[start..end], "offsetBytes": start, "revision": revision}),
            ))
        })
    }
    fn close(&self, ctx: PluginContext) -> PluginFuture {
        let revision = self.revision;
        Box::pin(async move {
            record(&ctx, "stream-close", revision, json!({})).await?;
            Ok(Value::Null)
        })
    }
}
#[derive(Default)]
struct SessionState {
    bytes: usize,
    characters: usize,
    words: usize,
    line_breaks: usize,
    previous_non_whitespace: bool,
    ends_with_newline: bool,
    chunks: usize,
}
impl SessionState {
    fn snapshot(&self, revision: &str) -> PluginResult<Value> {
        Ok(json!({
            "backend": "rust-dynamic", "revision": revision,
            "bytes": self.bytes, "characters": self.characters, "words": self.words,
            "lines": self.line_breaks + usize::from(self.bytes > 0 && !self.ends_with_newline),
            "chunks": self.chunks,
        }))
    }
    fn append(&mut self, revision: &str, text: &str) -> PluginResult<Value> {
        if text.len() > MAX_TEXT_BYTES - self.bytes {
            return Err(format!("session exceeds {MAX_TEXT_BYTES} UTF-8 bytes"));
        }
        // Work is linear in new input. Boundary state preserves words and CRLF
        // split across chunks without retaining or rescanning prior user text.
        for character in text.chars() {
            let non_whitespace = !character.is_whitespace();
            self.words += usize::from(non_whitespace && !self.previous_non_whitespace);
            self.previous_non_whitespace = non_whitespace;
            self.ends_with_newline = character == '\n';
            self.line_breaks += usize::from(self.ends_with_newline);
            self.characters += 1;
        }
        self.bytes += text.len();
        self.chunks += 1;
        self.snapshot(revision)
    }
}
struct TextSession {
    revision: &'static str,
    descriptor: ObjectDescriptor,
    state: Arc<Mutex<SessionState>>,
}
impl PluginObject for TextSession {
    fn descriptor(&self) -> ObjectDescriptor {
        self.descriptor.clone()
    }
    fn call(&self, ctx: PluginContext, method: &str, args: Value) -> PluginFuture {
        let method = method.to_owned();
        let revision = self.revision;
        let state = self.state.clone();
        Box::pin(async move {
            yield_once().await;
            ctx.cancellation.check()?;
            match (method.as_str(), args.as_array().map(Vec::as_slice)) {
                ("snapshot", Some([])) => state
                    .lock()
                    .map_err(|_| "TextSessionPoisoned")?
                    .snapshot(revision),
                ("append", Some([Value::String(text)])) => {
                    if text.len() > MAX_TEXT_BYTES {
                        return Err(format!("text exceeds {MAX_TEXT_BYTES} UTF-8 bytes"));
                    }
                    record(
                        &ctx,
                        "object-append",
                        revision,
                        json!({"bytes": text.len()}),
                    )
                    .await?;
                    ctx.cancellation.check()?;
                    state
                        .lock()
                        .map_err(|_| "TextSessionPoisoned")?
                        .append(revision, text)
                }
                _ => Err("session supports append(string) and snapshot()".into()),
            }
        })
    }
    fn close(&self, ctx: PluginContext) -> PluginFuture {
        let revision = self.revision;
        let state = self.state.clone();
        Box::pin(async move {
            record(&ctx, "object-close", revision, json!({})).await?;
            *state.lock().map_err(|_| "TextSessionPoisoned")? = SessionState::default();
            Ok(Value::Null)
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunks_preserve_unicode_boundaries_and_reconstruct_input() {
        let input = "a世界🦀\r\nlast";
        for size in [1, 2, 3, 4096] {
            let mut offset = 0;
            let mut pieces = vec![];
            while offset < input.len() {
                let end = chunk_end(input, offset, size);
                assert!(end > offset);
                let piece = &input[offset..end];
                assert!(piece.chars().count() <= size);
                pieces.push(piece);
                offset = end;
            }
            assert_eq!(pieces.join(""), input);
        }
    }
    #[test]
    fn chunks_reject_unbounded_or_ambiguous_arguments() {
        for invalid in [
            json!([]),
            json!(["text"]),
            json!(["text", 0]),
            json!(["text", 4097]),
            json!(["text", 1.5]),
            json!([42, 1]),
            json!(["x".repeat(MAX_TEXT_BYTES + 1), 1]),
        ] {
            assert!(chunk_arguments(invalid).is_err());
        }
        assert_eq!(chunk_arguments(json!(["", 1])).unwrap(), (String::new(), 1));
    }
    #[test]
    fn session_preserves_words_and_crlf_split_across_chunks() {
        let mut state = SessionState::default();
        for piece in ["hel", "lo 世", "界\r", "\nlast"] {
            state.append("v1", piece).unwrap();
        }
        let result = state.snapshot("v1").unwrap();
        let mut expected = crate::analyze("v1", "hello 世界\r\nlast").unwrap();
        expected["chunks"] = json!(4);
        assert_eq!(result, expected);
    }
    #[test]
    fn incremental_metrics_match_direct_analysis_at_every_unicode_boundary() {
        for input in [
            "",
            "hello",
            "a\r\nb\n",
            "\n\n",
            "\r",
            "a\t\u{2003}世界🦀",
            "a\r\n\nend\r",
        ] {
            let mut state = SessionState::default();
            let mut prefix = String::new();
            for character in input.chars() {
                let piece = character.to_string();
                prefix.push(character);
                let mut expected = crate::analyze("v1", &prefix).unwrap();
                expected["chunks"] = json!(prefix.chars().count());
                assert_eq!(state.append("v1", &piece).unwrap(), expected);
            }
            let mut expected = crate::analyze("v1", input).unwrap();
            expected["chunks"] = json!(input.chars().count());
            assert_eq!(state.snapshot("v1").unwrap(), expected);
        }
    }
    #[test]
    fn overflow_does_not_mutate_a_session_and_sessions_are_independent() {
        let mut one = SessionState::default();
        let two = SessionState::default();
        one.append("v1", &"x".repeat(MAX_TEXT_BYTES)).unwrap();
        let before = one.snapshot("v1").unwrap();
        assert!(one.append("v1", "界").is_err());
        assert_eq!(one.snapshot("v1").unwrap(), before);
        assert_eq!(two.snapshot("v1").unwrap()["bytes"], 0);
    }
    #[test]
    fn resource_factory_exposes_only_declared_owned_interfaces() {
        let factory = ResourceFactory {
            revision: "v1",
            failing: false,
        };
        let descriptor = factory.descriptor();
        assert_eq!(descriptor.inject, vec![AUDIT]);
        assert_eq!(descriptor.services[0].methods[0].kind, MethodKind::Stream);
        assert_eq!(descriptor.services[0].methods[1].kind, MethodKind::Object);
        let instance = factory.create(json!({})).unwrap();
        let session = instance.open_object(SERVICE, "session", json!([])).unwrap();
        assert_eq!(session.descriptor().ownership(), ObjectOwnership::Owned);
        assert!(factory.create(json!({"unused": true})).is_err());
    }
}
