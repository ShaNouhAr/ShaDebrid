import { config } from "./config.js";

const BASE = "https://api.alldebrid.com";

export class AllDebridError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AllDebridError";
  }
}

type ApiOk<T> = { status: "success"; data: T };
type ApiErr = { status: "error"; error: { code: string; message: string } };
type ApiResponse<T> = ApiOk<T> | ApiErr;

function unwrap<T>(json: unknown): T {
  const r = json as ApiResponse<T>;
  if (!r || typeof r !== "object" || !("status" in r)) {
    throw new AllDebridError("INVALID_RESPONSE", "Invalid API response");
  }
  if (r.status === "error") {
    throw new AllDebridError(r.error.code, r.error.message);
  }
  return r.data;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": config.userAgent,
  };
}

async function postForm<T>(
  apiKey: string,
  path: string,
  form: URLSearchParams,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      ...authHeaders(apiKey),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok && !json) {
    throw new AllDebridError(
      "HTTP_" + res.status,
      `HTTP ${res.status} from AllDebrid`,
    );
  }
  return unwrap<T>(json);
}

async function postMultipart<T>(
  apiKey: string,
  path: string,
  fd: FormData,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: fd,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok && !json) {
    throw new AllDebridError(
      "HTTP_" + res.status,
      `HTTP ${res.status} from AllDebrid`,
    );
  }
  return unwrap<T>(json);
}

// ---------------- Types ----------------

export type MagnetUploadResult = {
  magnets: Array<{
    magnet?: string;
    name?: string;
    hash?: string;
    size?: number;
    ready?: boolean;
    id?: number;
    error?: { code: string; message: string };
  }>;
};

export type MagnetFileUploadResult = {
  files: Array<{
    file?: string;
    name?: string;
    hash?: string;
    size?: number;
    ready?: boolean;
    id?: number;
    error?: { code: string; message: string };
  }>;
};

export type MagnetStatus = {
  id: number;
  filename: string;
  size: number;
  status: string;
  statusCode: number;
  downloaded?: number;
  uploaded?: number;
  seeders?: number;
  downloadSpeed?: number;
  uploadSpeed?: number;
  uploadDate?: number;
  completionDate?: number;
};

// Files tree node: either a file (n, s, l) or a folder (n, e[])
export type MagnetFileNode =
  | { n: string; s: number; l: string }
  | { n: string; e: MagnetFileNode[] };

export type MagnetFilesEntry = {
  id: number | string;
  files?: MagnetFileNode[];
  error?: { code: string; message: string };
};

export type UnlockResult = {
  link: string;
  filename: string;
  filesize: number;
  host?: string;
  hostDomain?: string;
  id?: string;
  delayed?: number;
};

export type UserInfo = {
  user: {
    username: string;
    email?: string;
    isPremium?: boolean;
    isTrial?: boolean;
    premiumUntil?: number;
  };
};

// ---------------- API ----------------

export async function ping(apiKey: string): Promise<UserInfo> {
  return postForm<UserInfo>(apiKey, "/v4/user", new URLSearchParams());
}

export async function uploadMagnets(
  apiKey: string,
  magnets: string[],
): Promise<MagnetUploadResult> {
  const form = new URLSearchParams();
  for (const m of magnets) form.append("magnets[]", m);
  return postForm<MagnetUploadResult>(apiKey, "/v4/magnet/upload", form);
}

export async function uploadTorrentFile(
  apiKey: string,
  filename: string,
  data: Buffer,
): Promise<MagnetFileUploadResult> {
  const fd = new FormData();
  const blob = new Blob([data], { type: "application/x-bittorrent" });
  fd.append("files[]", blob, filename);
  return postMultipart<MagnetFileUploadResult>(
    apiKey,
    "/v4/magnet/upload/file",
    fd,
  );
}

export async function magnetStatus(
  apiKey: string,
  id: number,
): Promise<MagnetStatus | null> {
  const form = new URLSearchParams();
  form.set("id", String(id));
  const data = await postForm<{ magnets: MagnetStatus | MagnetStatus[] }>(
    apiKey,
    "/v4.1/magnet/status",
    form,
  );
  const magnets = data.magnets;
  if (Array.isArray(magnets)) return magnets[0] ?? null;
  if (magnets && typeof magnets === "object") return magnets as MagnetStatus;
  return null;
}

export async function magnetFiles(
  apiKey: string,
  ids: number[],
): Promise<MagnetFilesEntry[]> {
  const form = new URLSearchParams();
  for (const id of ids) form.append("id[]", String(id));
  const data = await postForm<{ magnets: MagnetFilesEntry[] }>(
    apiKey,
    "/v4/magnet/files",
    form,
  );
  return data.magnets || [];
}

export async function deleteMagnet(apiKey: string, id: number): Promise<void> {
  const form = new URLSearchParams();
  form.set("id", String(id));
  await postForm<{ message: string }>(apiKey, "/v4/magnet/delete", form);
}

export async function unlockLink(
  apiKey: string,
  link: string,
  password?: string,
): Promise<UnlockResult> {
  const form = new URLSearchParams();
  form.set("link", link);
  if (password) form.set("password", password);
  return postForm<UnlockResult>(apiKey, "/v4/link/unlock", form);
}

// ---------------- Helpers ----------------

export type FlatFile = {
  path: string;
  size: number;
  link: string; // alldebrid.com/f/... locked link
};

export function flattenFiles(
  nodes: MagnetFileNode[] | undefined,
  prefix = "",
): FlatFile[] {
  if (!nodes) return [];
  const out: FlatFile[] = [];
  for (const node of nodes) {
    if ("l" in node && typeof node.l === "string") {
      out.push({
        path: prefix + node.n,
        size: node.s ?? 0,
        link: node.l,
      });
    } else if ("e" in node && Array.isArray(node.e)) {
      out.push(...flattenFiles(node.e, `${prefix}${node.n}/`));
    }
  }
  return out;
}

export const STATUS_READY = 4;
export function isErrorStatus(code: number): boolean {
  return code >= 5;
}
