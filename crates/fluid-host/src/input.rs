//! Fallible decoding after schema validation: numeric representations still need checking.
use fluid_protocol::{Result, RpcError};
use serde::de::DeserializeOwned;
use serde_json::Value;

pub(crate) fn parse<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|error| RpcError::new("INVALID_INPUT", format!("Invalid request: {error}")))
}
