import { Block, KeyValueTable } from "../components/Script";
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
    <div className="sheet-body">
      {emptyEnvironment && (
        <p className="notice">
          This bundle has no compiled environment yet. Authoring bundles carry only the definition
          and patches; the environment stage produces task.toml and the Dockerfiles.
        </p>
      )}
      {(environment || resources || timeouts) && (
        <Block title="environment contract" detail={environment?.source ?? ""}>
          <KeyValueTable
            rows={[
              ["base image", environment?.baseImage ?? "—"],
              ["workdir", model.definition?.workdir ?? "."],
              ["cpus", resources ? String(resources.cpus ?? "") : "—"],
              ["memory", resources?.memoryMb ? `${resources.memoryMb} MB` : "—"],
              ["storage", resources?.storageMb ? `${resources.storageMb} MB` : "—"],
              [
                "timeouts",
                timeouts
                  ? `setup ${timeouts.setupSeconds ?? "?"}s · agent ${timeouts.agentSeconds ?? "?"}s · tests ${timeouts.testsSeconds ?? "?"}s`
                  : "—",
              ],
              [
                "services",
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
            <button type="button" className="link" onClick={() => onOpenFile("task.toml")}>
              Open Raw
            </button>
          }
        >
          <table className="sheet-table">
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
        <Block title="environment variables" detail={`${envVars.length}`}>
          <table className="sheet-table">
            <tbody>
              {envVars.map(([name, value]) => (
                <tr key={name}>
                  <th className="mono">{name}</th>
                  <td className="code">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      )}
      {environment?.services && environment.services.length > 0 && (
        <Block title="services" detail={`${environment.services.length}`}>
          <table className="sheet-table">
            <thead>
              <tr>
                <th className="col">name</th>
                <th className="col">image</th>
                <th className="col">command</th>
                <th className="col">healthcheck</th>
                <th className="col">env</th>
              </tr>
            </thead>
            <tbody>
              {environment.services.map((service) => (
                <tr key={service.name ?? service.image}>
                  <td className="nowrap">{service.name}</td>
                  <td className="code">{service.image}</td>
                  <td className="code">{service.command?.join(" ") ?? ""}</td>
                  <td className="code">
                    {service.healthcheck?.test?.join(" ")}
                    {service.healthcheck && (
                      <span className="dim">
                        {` · every ${service.healthcheck.intervalSeconds}s · ${service.healthcheck.retries} retries`}
                      </span>
                    )}
                  </td>
                  <td className="code">
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
            <button type="button" className="link" onClick={() => onOpenFile(image.path)}>
              {image.path}
            </button>
          }
        >
          <table className="sheet-table">
            <tbody>
              {image.instructions.map((entry) => (
                <tr key={`${entry.line}`}>
                  <th className="kw">{entry.instruction}</th>
                  <td className="code">{entry.args}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      ))}
      {environment?.evidence && environment.evidence.length > 0 && (
        <Block
          title="evidence the environment agent cited"
          detail={`${environment.evidence.length}`}
        >
          <table className="sheet-table">
            <tbody>
              {uniqueKeys(environment.evidence, (item) => item.path ?? "").map(([key, item]) => (
                <tr key={key}>
                  <th className="path">{item.path}</th>
                  <td className="code">{item.reason}</td>
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
            <button type="button" className="link" onClick={() => onOpenFile(composePath)}>
              Open Raw
            </button>
          }
        >
          <pre className="prose">{model.compose}</pre>
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
          <th className="col" colSpan={2}>
            {repeated ? `[[${name}]]` : `[${name}]`}
          </th>
        </tr>
      )}
      {entries.map(([key, value]) => (
        <tr key={`${name}.${key}`}>
          <th className="mono">{key}</th>
          <td className="code">{formatTomlValue(value as never)}</td>
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
