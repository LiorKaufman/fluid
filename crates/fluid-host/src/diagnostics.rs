//! Internal error chains stay out of protocol replies; stderr contains safe categories only.
use fluid_protocol::RpcError;
use std::error::Error;

pub(crate) fn storage_error(error: impl Error + Send + Sync + 'static) -> RpcError {
    RpcError::new(
        "STORAGE_ERROR",
        "The database operation failed. No partial change was committed.",
    )
    .with_source(error)
}

/// Reports operational categories without exposing the source's potentially sensitive text.
pub fn report(error: &RpcError) {
    let Some(source) = error.source() else { return };
    // Do not print SQL, paths, user records, or provider configuration.
    let detail = if let Some(error) = source.downcast_ref::<rusqlite::Error>() {
        if let Some(code) = error.sqlite_error() {
            format!(
                "sqlite code={:?} extended={}",
                code.code, code.extended_code
            )
        } else {
            "sqlite conversion or database API failure".to_owned()
        }
    } else if let Some(error) = source.downcast_ref::<std::io::Error>() {
        format!(
            "filesystem kind={:?} os_code={:?}",
            error.kind(),
            error.raw_os_error()
        )
    } else if let Some(error) = source.downcast_ref::<serde_json::Error>() {
        format!(
            "json category={:?} line={} column={}",
            error.classify(),
            error.line(),
            error.column()
        )
    } else {
        "internal storage failure".to_owned()
    };
    eprintln!("fluid-native: {}: {detail}", error.code);
}
