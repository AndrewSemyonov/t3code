import { useId, useState, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SimlockDeviceHostConfig,
} from "@t3tools/contracts";
import { PlusIcon, ServerIcon, XIcon } from "lucide-react";

import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import {
  newSimlockDeviceHost,
  simlockDeviceHostProblem,
  simlockLeaseLimits,
  updateSimlockDeviceHosts,
} from "./simlockDeviceHostsSettings.logic";

const SIMLOCK_URL = "https://incubator.callstack.com/simlock/";

type TokenState = { kind: "saved" } | { kind: "new"; value: string } | { kind: "cleared" };

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/** Simlock hosts belong to one environment: its server holds the tokens and keeps the leases. */
export function SimlockDeviceHostsSettings(props: { environmentId: EnvironmentId | null }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const canConfigure = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const environment = connectedEnvironments.find(
    (candidate) => candidate.environmentId === props.environmentId,
  );
  const hosts = environment?.serverConfig?.settings.simlockDeviceHosts ?? [];
  const [editing, setEditing] = useState<{ host: SimlockDeviceHostConfig; isNew: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const disabled = !canConfigure || projectScope || busy || !props.environmentId;

  const save = async (host: SimlockDeviceHostConfig, remove: boolean) => {
    if (!props.environmentId || !readEnvironmentScope(props.environmentId, AuthSettingsWriteScope))
      return;
    setBusy(true);
    const result = await update({
      environmentId: props.environmentId,
      input: { patch: { simlockDeviceHosts: updateSimlockDeviceHosts(hosts, host, remove) } },
    });
    setBusy(false);
    if (result._tag === "Success") setEditing(null);
    else
      toastManager.add({
        type: "error",
        title: remove ? "Simlock host not removed" : "Simlock host not saved",
        description: failureMessage(result.cause),
      });
  };

  return (
    <SettingsRow
      id="simlock-device-hosts"
      title="Simlock (alpha)"
      serverScoped
      settingKeys={["simlockDeviceHosts"]}
      description={
        <>
          Lease simulators and emulators from your own pool. Alpha:{" "}
          <a
            href={SIMLOCK_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Simlock
          </a>{" "}
          is new and unreleased, and this integration may change or stop working. T3 Code does not
          install Simlock; point it at a gateway you run.
        </>
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || editing !== null}
          onClick={() => setEditing({ host: newSimlockDeviceHost(randomUUID()), isNew: true })}
        >
          <PlusIcon className="size-3.5" /> Add Simlock host
        </Button>
      }
    >
      <div className="pt-3 pb-2">
        {hosts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Simlock hosts.</p>
        ) : (
          <ul className="divide-y divide-border/40">
            {hosts.map((host) => (
              <li key={host.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate font-medium">
                    <ServerIcon className="size-3.5 shrink-0" /> {host.label}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {host.gatewayUrl} · {simlockLeaseLimits(host)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setEditing({ host, isNew: false })}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost-destructive"
                    disabled={disabled}
                    onClick={() => void save(host, true)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {editing ? (
          <SimlockDeviceHostEditor
            key={editing.host.id}
            host={editing.host}
            isNew={editing.isNew}
            busy={busy}
            onSave={(host) => void save(host, false)}
            onClose={() => setEditing(null)}
          />
        ) : null}
      </div>
    </SettingsRow>
  );
}

function SimlockDeviceHostEditor(props: {
  host: SimlockDeviceHostConfig;
  isNew: boolean;
  busy: boolean;
  onSave: (host: SimlockDeviceHostConfig) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(props.host);
  // Saved tokens arrive redacted; only a replacement or a clear changes them.
  const [agentToken, setAgentToken] = useState<TokenState>(
    props.host.agentToken ? { kind: "saved" } : { kind: "cleared" },
  );
  const [operatorToken, setOperatorToken] = useState<TokenState>(
    props.host.operatorToken ? { kind: "saved" } : { kind: "cleared" },
  );
  const tokenValue = (token: TokenState, saved: string) =>
    token.kind === "saved" ? saved : token.kind === "new" ? token.value : "";
  const next: SimlockDeviceHostConfig = {
    ...draft,
    label: draft.label.trim(),
    gatewayUrl: draft.gatewayUrl.trim(),
    agentToken: tokenValue(agentToken, props.host.agentToken),
    operatorToken: tokenValue(operatorToken, props.host.operatorToken),
  };
  const problem = simlockDeviceHostProblem(next);

  const limit = (
    field: "maxLeases" | "maxLeaseMinutes",
    label: string,
    min: number,
    max: number,
  ) => (
    <label className="block space-y-1.5">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={draft[field]}
        disabled={props.busy}
        onChange={(event) => {
          const value = Number(event.target.value);
          setDraft((current) => ({ ...current, [field]: value }));
        }}
      />
    </label>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!props.busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (problem === null && !props.busy) props.onSave(next);
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.isNew ? "Add Simlock host" : "Edit Simlock host"}</DialogTitle>
            <DialogDescription>
              The environment's server leases devices from your Simlock gateway and releases them
              when they close.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1.5 text-sm">
              <span>Name</span>
              <Input
                autoFocus
                required
                value={draft.label}
                disabled={props.busy}
                onChange={(event) => {
                  const label = event.target.value;
                  setDraft((current) => ({ ...current, label }));
                }}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>Gateway URL</span>
              <Input
                required
                type="url"
                placeholder="https://gateway.example.ts.net:4700"
                value={draft.gatewayUrl}
                disabled={props.busy}
                onChange={(event) => {
                  const gatewayUrl = event.target.value;
                  setDraft((current) => ({ ...current, gatewayUrl }));
                }}
              />
            </label>
            <SimlockTokenField
              label="Agent token"
              token={agentToken}
              hasSaved={props.host.agentToken !== ""}
              busy={props.busy}
              onChange={setAgentToken}
              help={
                <>
                  Leases and drives devices. Create one with{" "}
                  <code>simlock token create --role agent</code>.
                </>
              }
            />
            <SimlockTokenField
              label="Operator token"
              placeholder="Optional"
              token={operatorToken}
              hasSaved={props.host.operatorToken !== ""}
              busy={props.busy}
              onChange={setOperatorToken}
              help="Only for the live screen in the Device panel: Simlock streams screens to operator tokens alone. An operator token can manage the whole pool, so add one only if you need the live view."
            />
            <div className="grid grid-cols-2 gap-3 text-sm">
              {limit("maxLeases", "Devices at once", 1, 20)}
              {limit("maxLeaseMinutes", "Lease minutes", 5, 240)}
            </div>
            <p className="text-xs text-muted-foreground">
              A lease ends after the lease minutes even while in use.
              {props.isNew ? null : " Saving restarts this host, which releases its devices."}
            </p>
            {problem === null ? null : (
              <p className="text-xs text-destructive" role="alert">
                {problem}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.busy || problem !== null}>
              {props.busy ? <Spinner size="xs" /> : null} Save host
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function SimlockTokenField(props: {
  label: string;
  placeholder?: string;
  token: TokenState;
  hasSaved: boolean;
  busy: boolean;
  help: ReactNode;
  onChange: (token: TokenState) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5 text-sm">
      <label htmlFor={id} className="block">
        {props.label}
      </label>
      <div className="flex items-center gap-2">
        <SecretInput
          id={id}
          className="min-w-0 flex-1"
          configured={props.token.kind === "saved"}
          value={props.token.kind === "new" ? props.token.value : ""}
          disabled={props.busy}
          {...(props.placeholder ? { placeholder: props.placeholder } : {})}
          onChange={(event) => {
            const value = event.target.value;
            // Emptying the field is not clearing the saved token; the Clear
            // button is, so a saved token comes back here.
            props.onChange(
              value
                ? { kind: "new", value }
                : props.hasSaved
                  ? { kind: "saved" }
                  : { kind: "cleared" },
            );
          }}
        />
        {props.token.kind !== "cleared" ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-destructive"
            aria-label={`Clear ${props.label.toLowerCase()}`}
            disabled={props.busy}
            onClick={() => props.onChange({ kind: "cleared" })}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{props.help}</p>
    </div>
  );
}
