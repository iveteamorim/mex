export {
  AgentAssetsError,
  MEX_MANAGED_SKILL_METADATA,
  MEX_MANAGED_SKILL_SCHEMA_VERSION,
  applyAgentAssetsPlan,
  defaultAgentSkillIgnoreChecker,
  planAgentAssets,
  resolvePackagedSkillsRoot,
  syncAgentAssets,
} from "./installer.js";
export type {
  AgentAssetsErrorCode,
  MexManagedSkillMetadata,
} from "./installer.js";

export {
  KNOWN_LEGACY_INSTRUCTION_SHA256,
  MAX_MANAGED_INSTRUCTION_PREVIEW_BYTES,
  MEX_INSTRUCTIONS_END,
  MEX_INSTRUCTIONS_START,
  planManagedInstructionEdit,
  renderManagedInstructionBlock,
} from "./instructions.js";
export { renderInstructionChangePreview } from "./report.js";
export type { ManagedInstructionEdit } from "./instructions.js";

export {
  AGENT_SKILL_TARGETS,
  OFFICIAL_MEX_SKILLS,
  SUPPORTED_AGENT_SKILL_CLIENTS,
} from "./types.js";
export type {
  AgentAssetAction,
  AgentAssetActionName,
  AgentAssetWarning,
  AgentAssetWarningCode,
  AgentInstructionChange,
  AgentInstructionChangeScope,
  AgentAssetsApplyHooks,
  AgentAssetsApplyOptions,
  AgentAssetsPlan,
  AgentAssetsReport,
  AgentAssetsSyncOptions,
  AgentSkillClient,
  AgentSkillIgnoreChecker,
  AgentSkillTarget,
  OfficialMexSkill,
} from "./types.js";
