import { z } from "zod";

/** Tiny validation boundary for consumers that only need portable Hub links. */
export const TeamMemberIdSchema = z.string()
  .regex(/^member_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid member ID.");

export const RelayIdSchema = z.string()
  .regex(/^relay_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Relay ID.");

export const InboxProposalIdSchema = z.string()
  .regex(/^proposal_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Inbox proposal ID.");

export const GraphSymbolIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Graph symbol ID contains unsafe characters.");

export const WikiEntityIdSchema = z.string()
  .regex(/^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Wiki entity ID.");

export type TeamMemberId = z.infer<typeof TeamMemberIdSchema>;
export type RelayId = z.infer<typeof RelayIdSchema>;
export type InboxProposalId = z.infer<typeof InboxProposalIdSchema>;
export type GraphSymbolId = z.infer<typeof GraphSymbolIdSchema>;
export type WikiEntityId = z.infer<typeof WikiEntityIdSchema>;
