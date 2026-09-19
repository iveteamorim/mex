export function execute(query: string): string[] {
  return rankSearchResults([query]);
}

export function rankSearchResults(items: string[]): string[] {
  return [...items].sort();
}
