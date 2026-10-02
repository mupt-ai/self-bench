import { GoogleAuth } from "google-auth-library";

let auth: GoogleAuth | undefined;

/**
 * An OAuth access token for the process's own Google identity (the Cloud Run or GKE service
 * account), for the Cloud Build and Artifact Registry APIs. The library caches and refreshes it.
 */
export async function googleAccessToken(): Promise<string> {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const token = await auth.getAccessToken();
  if (!token) throw new Error("Google credentials returned no access token");
  return token;
}
