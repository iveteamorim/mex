import { z } from "zod";
export { WEB3FORMS_ACCESS_KEY, WEB3FORMS_SUBMIT_URL, CONTACT_SUBMIT_ERROR, submitContactPayload } from "./setup-contact.js";

export const ContactPreferenceSchema = z.object({
  status: z.enum(["unasked", "skipped", "submitted", "unavailable"]),
}).strict();
export const ContactPreferenceRequestSchema = z.object({ status: z.enum(["skipped", "submitted"]) }).strict();
export const SetupContactRequestSchema = z.object({
  email: z.string().trim().min(1).max(320).email(),
  name: z.string().trim().max(200).default(""),
}).strict();
export const SetupContactResponseSchema = z.object({
  ok: z.boolean(),
  status: ContactPreferenceSchema.shape.status,
  message: z.string().min(1).max(512),
}).strict();
export type ContactPreference = z.infer<typeof ContactPreferenceSchema>;
export type ContactPreferenceRequest = z.infer<typeof ContactPreferenceRequestSchema>;
export type SetupContactRequest = z.infer<typeof SetupContactRequestSchema>;
export type SetupContactResponse = z.infer<typeof SetupContactResponseSchema>;
