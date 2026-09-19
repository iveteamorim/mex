pub fn resolve_call_path(symbol: &str) -> String {
    symbol.to_string()
}

pub fn index_workspace(entry: &str) -> String {
    resolve_call_path(entry)
}
