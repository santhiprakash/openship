import { Type, type Static } from "@sinclair/typebox";

export const CreateTokenBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  /** Read-only tokens reject mutation methods (POST/PUT/PATCH/DELETE). */
  readOnly: Type.Optional(Type.Boolean()),
  /** Optional expiry, in days from now (1–365). Omit for a non-expiring token. */
  expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
});
export type TCreateTokenBody = Static<typeof CreateTokenBody>;
