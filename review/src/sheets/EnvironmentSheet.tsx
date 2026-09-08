import { Block, KeyValueTable } from "../components/Script";
import {
  notice,
  prose,
  sheetBody,
  sheetTable,
  tableCode,
  tableColumn,
  tableMono,
  viewerLink,
} from "../components/viewer-ui";
import { dockerfileEnvironment } from "../lib/dockerfile";
import type { TaskModel } from "../lib/task-model";
import { formatTomlValue } from "../lib/toml";

export function EnvironmentSheet({
  model,
  onOpenFile,
}: {
  model: TaskModel;
  onOpenFile: (path: string) => void;
}) {
  const environment = model.definition?.environment;
  const envVars = environment?.environmentVariables
    ? Object.entries(environment.environmentVariables)
    : dockerfileEnvironment(model.images[0]?.instructions ?? []);
  const resources = model.definition?.resources;
  const timeouts = model.definition?.timeouts;
  const emptyEnvironment = model.toml.length === 0 && model.images.length === 0 && !environment;
  const composePath = model.composePath;
  return (
    <div className={sheetBody}>
      {emptyEnvironment && (
        <p className={`${notice} site:p-0!`}>
          This bundle has no compiled environment yet. Authoring bundles carry only the definition
          and patches; the environment stage produces task.toml and the Dockerfiles.
        </p>
      )}
      {(environment || resources || timeouts) && (
        <Block title="Environment Contract" detail={environment?.source ?? ""}>
          <KeyValueTable
            rows={[
              ["Base Image", environment?.baseImage ?? "—"],
              ["Workdir", model.definition?.workdir ?? "."],
              ["CPUs", resources ? String(resources.cpus ?? "") : "—"],
              ["Memory", resources?.memoryMb ? `${resources.memoryMb} MB` : "—"],
              ["Storage", resources?.storageMb ? `${resources.storageMb} MB` : "—"],
              [
                "Timeouts",
                timeouts
                  ? `setup ${timeouts.setupSeconds ?? "?"}s · agent ${timeouts.agentSeconds ?? "?"}s · tests ${timeouts.testsSeconds ?? "?"}s`
                  : "—",
              ],
              [
                "Services",
                environment?.services?.length ? `${environment.services.length}` : "none",
              ],
            ]}
          />
        </Block>
      )}
      {model.toml.length > 0 && (
        <Block
          title="task.toml"
          right={
            <button type="button" className={viewerLink} onClick={() => onOpenFile("task.toml")}>
              Open Raw
            </button>
          }
        >
          <table className={sheetTable}>
            <tbody>
              {uniqueKeys(model.toml, (section) => section.name).map(([key, section]) => (
                <SectionRows
                  key={key}
                  name={section.name}
                  entries={section.entries}
                  repeated={section.repeated}
                />
              ))}
            </tbody>
          </table>
        </Block>
      )}
      {envVars.length > 0 && (
        <Block title="Environment Variables" detail={`${envVars.length}`}>
          <table className={sheetTable}>
            <tbody>
              {envVars.map(([name, value]) => (
                <tr key={name}>
                  <th className={tableMono}>{name}</th>
                  <td className={tableCode}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      )}
      {environment?.services && environment.services.length > 0 && (
        <Block title="Services" detail={`${environment.services.length}`}>
          <table className={sheetTable}>
            <thead>
              <tr>
                <th className={tableColumn}>Name</th>
                <th className={tableColumn}>Image</th>
                <th className={tableColumn}>Command</th>
                <th className={tableColumn}>Healthcheck</th>
                <th className={tableColumn}>Env</th>
              </tr>
            </thead>
            <tbody>
              {environment.services.map((service) => (
                <tr key={service.name ?? service.image}>
                  <td className="whitespace-nowrap site:!font-mono">{service.name}</td>
                  <td className={tableCode}>{service.image}</td>
                  <td className={tableCode}>{service.command?.join(" ") ?? ""}</td>
                  <td className={tableCode}>
                    {service.healthcheck?.test?.join(" ")}
                    {service.healthcheck && (
                      <span className="text-(--muted-fg) site:text-dim">
                        {` · every ${service.healthcheck.intervalSeconds}s · ${service.healthcheck.retries} retries`}
                      </span>
                    )}
                  </td>
                  <td className={tableCode}>
                    {Object.entries(service.environmentVariables ?? {})
                      .map(([key, value]) => `${key}=${value}`)
                      .join("\n")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      )}
      {model.images.map((image) => (
        <Block
          key={image.path}
          title={image.label}
          detail={`${image.instructions.length} instructions`}
          right={
            <button type="button" className={viewerLink} onClick={() => onOpenFile(image.path)}>
              {image.path}
            </button>
          }
        >
          <table className={sheetTable}>
            <tbody>
              {image.instructions.map((entry) => (
                <tr key={`${entry.line}`}>
                  <th className="!font-medium !text-(--brand) site:font-mono site:!text-mint">
                    {entry.instruction}
                  </th>
                  <td className={tableCode}>{entry.args}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      ))}
      {environment?.evidence && environment.evidence.length > 0 && (
        <Block
          title="Evidence the Environment Agent Cited"
          detail={`${environment.evidence.length}`}
        >
          <table className={sheetTable}>
            <tbody>
              {uniqueKeys(environment.evidence, (item) => item.path ?? "").map(([key, item]) => (
                <tr key={key}>
                  <th className="text-(--foreground) site:font-mono site:text-sm">{item.path}</th>
                  <td className={tableCode}>{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      )}
      {model.compose && composePath && (
        <Block
          title="docker-compose.yaml"
          detail={composePath}
          right={
            <button type="button" className={viewerLink} onClick={() => onOpenFile(composePath)}>
              Open Raw
            </button>
          }
        >
          <pre className={prose}>{model.compose}</pre>
        </Block>
      )}
    </div>
  );
}

function SectionRows({
  name,
  entries,
  repeated,
}: {
  name: string;
  entries: [string, unknown][];
  repeated: boolean;
}) {
  return (
    <>
      {name && (
        <tr>
          <th className={tableColumn} colSpan={2}>
            {repeated ? `[[${name}]]` : `[${name}]`}
          </th>
        </tr>
      )}
      {entries.map(([key, value]) => (
        <tr key={`${name}.${key}`}>
          <th className={tableMono}>{key}</th>
          <td className={tableCode}>{formatTomlValue(value as never)}</td>
        </tr>
      ))}
    </>
  );
}

/** Stable React keys for lists whose items may repeat: the second "x" becomes "x·2". */
function uniqueKeys<T>(items: T[], keyOf: (item: T) => string): [string, T][] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return [count === 1 ? base : `${base}·${count}`, item];
  });
}
