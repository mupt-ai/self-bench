export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
export interface UploadPreview {
  receipt: string;
  tasks: { taskId: string; digest: string; errors: string[]; conflicts: string[] }[];
  manifest?: Record<string, unknown>;
}
export async function uploadArchive(
  org: string,
  fullName: string,
  file: File,
  receipt?: string,
  signal?: AbortSignal,
): Promise<UploadPreview | { imported: number }> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(org)}/repos/${fullName}/uploads/${receipt ? "import" : "preview"}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...(receipt ? { "x-upload-preview": receipt } : {}),
      },
      body: file,
      ...(signal ? { signal } : {}),
    },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Upload failed (${response.status})`);
  return result;
}
