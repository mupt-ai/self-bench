import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOBBY_VERCEL_TIMEOUT_CAP_MS } from "../src/sandbox/timeout.js";
import {
  applyVercelProfile,
  loadVercelProfileData,
  profileFilePaths,
  saveVercelProfile,
  type VercelProfile,
} from "../src/setup/vercel/profile.js";

const roots: string[] = [];
const image = `selfbench-runtime@sha256:${"a".repeat(64)}`;
const profile: VercelProfile = {
  teamId: "team_test",
  teamSlug: "test-team",
  teamName: "Test Team",
  projectId: "prj_test",
  projectName: "selfbench-sandbox",
  vcrRepository: "selfbench-runtime",
  image,
  runtimeFingerprint: "b".repeat(64),
  timeoutCapMs: HOBBY_VERCEL_TIMEOUT_CAP_MS,
  capabilityCheckedAt: "2026-08-16T12:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Vercel profiles", () => {
  test("stores profile metadata and credentials atomically with owner-only permissions", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, ".selfbench");

    await saveVercelProfile({
      directory,
      profileName: "default",
      profile,
      token: "vcp_secret_token",
    });

    const paths = profileFilePaths(directory);
    const [data, directoryStats, configStats, credentialsStats, configText, credentialsText] =
      await Promise.all([
        loadVercelProfileData(directory),
        lstat(directory),
        lstat(paths.config),
        lstat(paths.credentials),
        readFile(paths.config, "utf8"),
        readFile(paths.credentials, "utf8"),
      ]);
    expect(data.activeVercelProfile).toBe("default");
    expect(data.profiles.default).toEqual(profile);
    expect(data.tokens.default).toBe("vcp_secret_token");
    expect(directoryStats.mode & 0o777).toBe(0o700);
    expect(configStats.mode & 0o777).toBe(0o600);
    expect(credentialsStats.mode & 0o777).toBe(0o600);
    expect(configText).not.toContain("vcp_secret_token");
    expect(credentialsText).toContain("vcp_secret_token");
    expect((await lstat(directory)).isDirectory()).toBe(true);
  });

  test("resolves the active profile while preserving explicit token and image overrides", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, ".selfbench");
    await saveVercelProfile({
      directory,
      profileName: "default",
      profile,
      token: "stored-token",
    });

    const environment = await applyVercelProfile({
      SELFBENCH_CONFIG_DIR: directory,
      VERCEL_TOKEN: "replacement-token",
      SELFBENCH_VERCEL_IMAGE: `alternate@sha256:${"c".repeat(64)}`,
    });

    expect(environment).toMatchObject({
      VERCEL_TOKEN: "replacement-token",
      VERCEL_TEAM_ID: profile.teamId,
      VERCEL_PROJECT_ID: profile.projectId,
      SELFBENCH_VERCEL_IMAGE: `alternate@sha256:${"c".repeat(64)}`,
      SELFBENCH_VERCEL_TIMEOUT_CAP: `${HOBBY_VERCEL_TIMEOUT_CAP_MS}ms`,
    });
  });

  test("never combines a profile with a different explicit team or project", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, ".selfbench");
    await saveVercelProfile({ directory, profileName: "default", profile, token: "token" });

    await expect(
      applyVercelProfile({ SELFBENCH_CONFIG_DIR: directory, VERCEL_TEAM_ID: "team_other" }),
    ).rejects.toThrow("does not match the selected Vercel profile");
    await expect(
      applyVercelProfile({ SELFBENCH_CONFIG_DIR: directory, VERCEL_PROJECT_ID: "prj_other" }),
    ).rejects.toThrow("does not match the selected Vercel profile");
  });

  test("allows a stricter timeout override but never exceeds the profile's verified ceiling", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, ".selfbench");
    await saveVercelProfile({ directory, profileName: "default", profile, token: "token" });

    expect(
      await applyVercelProfile({
        SELFBENCH_CONFIG_DIR: directory,
        SELFBENCH_VERCEL_TIMEOUT_CAP: "30m",
      }),
    ).toMatchObject({ SELFBENCH_VERCEL_TIMEOUT_CAP: "30m" });
    await expect(
      applyVercelProfile({
        SELFBENCH_CONFIG_DIR: directory,
        SELFBENCH_VERCEL_TIMEOUT_CAP: "2h",
      }),
    ).rejects.toThrow("selected profile's verified");
    await expect(
      applyVercelProfile({
        SELFBENCH_CONFIG_DIR: directory,
        SELFBENCH_VERCEL_TIMEOUT_CAP: "invalid",
      }),
    ).rejects.toThrow("selected profile's verified");
  });

  test("supports multiple named profiles and makes the most recently configured one active", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, ".selfbench");
    await saveVercelProfile({
      directory,
      profileName: "first",
      profile,
      token: "first-token",
    });
    await saveVercelProfile({
      directory,
      profileName: "second",
      profile: {
        ...profile,
        teamId: "team_second",
        teamSlug: "second-team",
        teamName: "Second Team",
        projectId: "prj_second",
        projectName: "second-project",
      },
      token: "second-token",
    });

    expect(await applyVercelProfile({ SELFBENCH_CONFIG_DIR: directory })).toMatchObject({
      VERCEL_TOKEN: "second-token",
      VERCEL_PROJECT_ID: "prj_second",
    });
    expect(await applyVercelProfile({ SELFBENCH_CONFIG_DIR: directory }, "first")).toMatchObject({
      VERCEL_TOKEN: "first-token",
      VERCEL_PROJECT_ID: profile.projectId,
    });
  });

  test("keeps complete environment-only deployments independent of local profiles", async () => {
    const parent = await temporaryDirectory();
    const invalidConfigPath = join(parent, "not-a-directory");
    await writeFile(invalidConfigPath, "unrelated");
    const environment = {
      SELFBENCH_CONFIG_DIR: invalidConfigPath,
      VERCEL_TOKEN: "token",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "project",
      SELFBENCH_VERCEL_IMAGE: image,
    };

    expect(await applyVercelProfile(environment)).toEqual(environment);
  });

  test("rejects conflicting paths and profile files with exposed permissions", async () => {
    const parent = await temporaryDirectory();
    const fileInsteadOfDirectory = join(parent, "file");
    await writeFile(fileInsteadOfDirectory, "not a directory");
    await expect(loadVercelProfileData(fileInsteadOfDirectory)).rejects.toThrow(
      "must be a directory",
    );

    const directory = join(parent, ".selfbench");
    await saveVercelProfile({ directory, profileName: "default", profile, token: "token" });
    await chmod(profileFilePaths(directory).credentials, 0o644);
    await expect(loadVercelProfileData(directory)).rejects.toThrow("chmod 600");

    const occupiedDirectory = join(parent, "occupied");
    await mkdir(occupiedDirectory, { mode: 0o700 });
    const occupiedConfig = profileFilePaths(occupiedDirectory).config;
    await writeFile(occupiedConfig, '{"belongsToAnotherTool":true}\n', { mode: 0o600 });
    await expect(loadVercelProfileData(occupiedDirectory)).rejects.toThrow(
      "set SELFBENCH_CONFIG_DIR to another directory",
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-profile-"));
  roots.push(root);
  return root;
}
