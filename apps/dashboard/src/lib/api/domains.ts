import { ApiError, api } from "./client";
import { endpoints } from "./endpoints";

export interface DomainVerifyResult {
  verified: boolean;
  cnameVerified?: boolean;
  txtVerified?: boolean;
  message?: string;
  sslStatus?: string;
}

export const domainsApi = {
  /** Get DNS records preview for a hostname (no domain creation needed). */
  previewRecords: (hostname: string) =>
    api.post<{
      data: {
        mode: "cloud" | "selfhosted";
        records: Array<{ type: "CNAME" | "A" | "TXT"; host: string; value: string }>;
      };
    }>(endpoints.domains.preview, { hostname }),

  /**
   * Re-run DNS verification for a domain.
   *
   * Returns the verify result on BOTH success and failure — the backend
   * returns 422 with the same shape when verification fails so the UI
   * can surface cnameVerified/txtVerified/message inline without a
   * second request. Any error other than 422 (network, 4xx, 5xx) is
   * re-thrown so callers can show a generic failure toast.
   */
  verify: async (domainId: string): Promise<DomainVerifyResult> => {
    try {
      return await api.post<DomainVerifyResult>(endpoints.domains.verify(domainId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.body && typeof err.body === "object") {
        return err.body as DomainVerifyResult;
      }
      throw err;
    }
  },
};
