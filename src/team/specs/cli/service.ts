import type {
  SpecListRequest,
  SpecListResult,
  SpecReadService,
  SpecShowResult,
} from "../service.js";

/** Leaf dependency used by the unregistered Checkpoint D command builder. */
export interface SpecCliService {
  list(request?: SpecListRequest): Promise<SpecListResult>;
  show(id: string): Promise<SpecShowResult>;
}

export type SpecCliServiceFactory = () =>
  | SpecCliService
  | Promise<SpecCliService>;

export function asSpecCliService(service: SpecReadService): SpecCliService {
  return service;
}
