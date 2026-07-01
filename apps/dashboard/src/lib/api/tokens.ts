import { api } from "./client";
import { endpoints } from "./endpoints";

export interface AccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  readOnly: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Returned only from create — carries the one-time plaintext `token`. */
export interface CreatedAccessToken extends AccessToken {
  token: string;
}

export const tokensApi = {
  list: () => api.get<{ data: AccessToken[] }>(endpoints.tokens.list),
  create: (body: { name: string; readOnly?: boolean; expiresInDays?: number }) =>
    api.post<{ data: CreatedAccessToken }>(endpoints.tokens.list, body),
  revoke: (id: string) => api.delete<{ data: { revoked: boolean } }>(endpoints.tokens.item(id)),
};
