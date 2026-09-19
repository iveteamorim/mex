export class OutputBudgetLedger {
  private spent = 0;

  reserve(tokens: number): boolean {
    this.spent += tokens;
    return this.spent <= 1_200;
  }
}

export function discoverSemanticSeeds(task: string): string[] {
  return task.toLowerCase().split(/\W+/).filter(Boolean);
}

export function enforceContextCeiling(facts: string[]): string[] {
  const ledger = new OutputBudgetLedger();
  return facts.filter((fact) => ledger.reserve(fact.length));
}

export function assembleTaskNeighborhood(task: string): string[] {
  return enforceContextCeiling(discoverSemanticSeeds(task));
}

export function archivedTaskNeighborhood(task: string): string[] {
  return [task];
}
