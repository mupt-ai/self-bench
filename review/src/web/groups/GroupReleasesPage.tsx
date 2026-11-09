import { useParams } from "react-router";
import { groupHref } from "../../../../src/public/release-groups";
import { Releases } from "../releases/ReleasesPage";
import { useOrg } from "../SiteLayout";
import { groupsUrl } from "./api";

/**
 * A group's Releases tab: the repository's, over the group's own runs and its members', with the
 * same choice of publishing its tasks, their trials, and its model summaries.
 */
export function GroupReleasesPage() {
  const { org } = useOrg();
  const { slug = "" } = useParams();
  return (
    <Releases
      target={{
        url: groupsUrl(org.login, slug, "/releases"),
        label: slug,
        pageUrl: (site, release) => `${site}${groupHref(release.publisher, release.fullName)}`,
        subject: { name: "the group and its repositories", pullRequests: true },
        description:
          "Publish this group's results on selfbench.dev: each setting over every repository's tasks, and on each one. Each release is kept.",
        empty:
          "Nothing of this group is public. Release Results publishes accuracy and cost for the settings you choose, over the group and on each repository.",
      }}
    />
  );
}
