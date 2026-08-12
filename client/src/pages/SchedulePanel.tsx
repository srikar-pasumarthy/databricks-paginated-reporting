import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Badge,
  Spinner,
  Alert,
  AlertDescription,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  RadioGroup,
  RadioGroupItem,
} from '@databricks/appkit-ui/react';
import { Mail, Plus, Trash2, Send, Clock, Users, Split } from 'lucide-react';
import {
  api,
  type Schedule,
  type SchedulesResponse,
  type Frequency,
  type DeliveryMode,
  type ReportColumn,
  type GroupValuesResponse,
} from '../lib/api';
import { run } from '../lib/utils';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function timezoneOptions(): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const common = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'UTC',
    'Europe/London',
  ];
  return [local, ...common.filter((t) => t !== local)];
}

/** One row of the split recipient map in the form. */
interface SplitRow {
  value: string | null;
  recipients: string;
}

interface DraftState {
  mode: DeliveryMode;
  recipients: string;
  splitColumn: string;
  splitRows: SplitRow[];
  subject: string;
  frequency: Frequency;
  weekday: number;
  dayOfMonth: number;
  hour: number;
  minute: number;
  cron: string;
  timezone: string;
}

function emptyDraft(defaultSplitColumn: string): DraftState {
  return {
    mode: 'single',
    recipients: '',
    splitColumn: defaultSplitColumn,
    splitRows: [],
    subject: '',
    frequency: 'weekly',
    weekday: 1,
    dayOfMonth: 1,
    hour: 8,
    minute: 0,
    cron: '0 8 * * 1',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function SchedulePanel({
  reportId,
  canSend,
  groupBy,
  columns,
}: {
  reportId: string;
  canSend: boolean;
  groupBy: string[];
  columns: ReportColumn[];
}) {
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [draft, setDraft] = useState<DraftState>(emptyDraft(groupBy[0] ?? ''));

  const labelFor = (name: string) => columns.find((c) => c.name === name)?.label ?? name;

  const load = useCallback(async () => {
    try {
      setData(await api.get<SchedulesResponse>(`/api/reports/${reportId}/schedules`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Load distinct values of the chosen split column into blank mapping rows. */
  const loadGroups = async () => {
    if (!draft.splitColumn) return;
    setLoadingGroups(true);
    setError(null);
    try {
      const res = await api.get<GroupValuesResponse>(
        `/api/reports/${reportId}/group-values?column=${encodeURIComponent(draft.splitColumn)}`,
      );
      setDraft((d) => ({
        ...d,
        splitRows: res.values.map((v) => ({ value: v.value, recipients: '' })),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingGroups(false);
    }
  };

  /** Build the API payload from the draft (single or split). */
  const payloadFromDraft = (d: DraftState) => {
    const base = {
      subject: d.subject,
      frequency: d.frequency,
      weekday: d.weekday,
      dayOfMonth: d.dayOfMonth,
      hour: d.hour,
      minute: d.minute,
      cron: d.cron,
      timezone: d.timezone,
      mode: d.mode,
    };
    if (d.mode === 'split') {
      return {
        ...base,
        split_column: d.splitColumn,
        recipient_map: d.splitRows
          .map((r) => ({
            value: r.value,
            recipients: r.recipients
              .split(/[,;\s]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          }))
          .filter((r) => r.recipients.length > 0),
      };
    }
    return {
      ...base,
      recipients: d.recipients
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  };

  const createSchedule = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/reports/${reportId}/schedules`, payloadFromDraft(draft));
      setShowForm(false);
      setDraft(emptyDraft(groupBy[0] ?? ''));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (s: Schedule) => {
    setError(null);
    try {
      await api.patch(`/api/schedules/${s.id}`, { enabled: !s.enabled });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (s: Schedule) => {
    if (!confirm('Delete this schedule?')) return;
    setError(null);
    try {
      await api.del(`/api/schedules/${s.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sendNow = async (s: Schedule) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload =
        s.mode === 'split'
          ? { mode: 'split', split_column: s.split_column, recipient_map: s.recipient_map, subject: s.subject, body: s.body }
          : { mode: 'single', recipients: s.recipients, subject: s.subject, body: s.body };
      const res = await api.post<{
        mode: DeliveryMode;
        slices: { group_value: string | null; status: string; row_count: number }[];
      }>(`/api/reports/${reportId}/send-now`, payload);
      const previews = res.slices.filter((x) => x.status === 'preview').length;
      const sent = res.slices.filter((x) => x.status === 'sent').length;
      const failed = res.slices.filter((x) => x.status === 'failed').length;
      const verb = previews > 0 && sent === 0 ? 'Previewed' : 'Sent';
      setNotice(
        `${verb} ${res.slices.length} ${res.mode === 'split' ? 'group email(s)' : 'email'}` +
          (failed ? ` — ${failed} failed` : '') +
          (previews > 0 && sent === 0 ? ' (no SMTP configured; render + log only).' : '.'),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const mappedCount = draft.splitRows.filter((r) => r.recipients.trim()).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4" /> Email schedule
        </CardTitle>
        <CardDescription>
          Email this report as a PDF on a recurring schedule — either the whole report to one list, or
          split by a group so each group&apos;s data goes to its own recipients.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data && !data.mailerConfigured && (
          <Alert>
            <AlertDescription>
              <strong>Preview mode.</strong> No SMTP server is configured, so schedules run but only
              render + log the send (no mail leaves the app). Add SMTP credentials to the app&apos;s
              secret scope to start delivering for real.
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        {/* Existing schedules */}
        {data?.schedules.length ? (
          <div className="space-y-2">
            {data.schedules.map((s) => (
              <div key={s.id} className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium text-sm flex-1">{s.summary}</span>
                  <Switch checked={s.enabled} onCheckedChange={() => run(() => toggleEnabled(s))()} />
                  <Button size="sm" variant="ghost" disabled={!canSend || busy} onClick={() => run(() => sendNow(s))()}>
                    <Send className="h-3.5 w-3.5 mr-1" /> Send now
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => run(() => remove(s))()}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground pl-6 flex items-center gap-2 flex-wrap">
                  {s.mode === 'split' ? (
                    <>
                      <Badge variant="secondary" className="gap-1">
                        <Split className="h-3 w-3" /> Split by {labelFor(s.split_column ?? '')}
                      </Badge>
                      <span>{s.recipient_map.length} group(s) → their own recipients</span>
                    </>
                  ) : (
                    <>
                      <Badge variant="outline" className="gap-1">
                        <Users className="h-3 w-3" /> Full report
                      </Badge>
                      <span>To: {s.recipients.join(', ')}</span>
                    </>
                  )}
                  {!s.enabled && <Badge variant="outline">paused</Badge>}
                </div>
                <div className="text-xs text-muted-foreground pl-6">
                  Next run: {s.enabled ? fmt(s.next_run_at) : '—'} · Last run: {fmt(s.last_run_at)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          data && <p className="text-sm text-muted-foreground">No schedules yet.</p>
        )}

        {/* Add form */}
        {showForm ? (
          <div className="rounded-md border p-4 space-y-4">
            {/* Delivery mode */}
            <div className="space-y-1.5">
              <Label className="text-sm">Delivery</Label>
              <RadioGroup
                value={draft.mode}
                onValueChange={(v) => setDraft({ ...draft, mode: v as DeliveryMode })}
                className="flex flex-col gap-1.5"
              >
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="single" className="mt-0.5" />
                  <span>
                    <span className="font-medium">Full report to one list</span>
                    <span className="text-muted-foreground"> — everyone gets the whole report.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="split" className="mt-0.5" disabled={groupBy.length === 0} />
                  <span>
                    <span className="font-medium">Split by group</span>
                    <span className="text-muted-foreground">
                      {groupBy.length === 0
                        ? ' — add a group-by column to the report to enable this.'
                        : ' — each group value gets a filtered report sent to its own recipients.'}
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </div>

            {/* Recipients (single) or split mapping */}
            {draft.mode === 'single' ? (
              <div className="space-y-1.5">
                <Label className="text-sm">Recipients</Label>
                <Input
                  placeholder="alice@example.com, bob@example.com"
                  value={draft.recipients}
                  onChange={(e) => setDraft({ ...draft, recipients: e.target.value })}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-end gap-2 flex-wrap">
                  <div className="space-y-1.5">
                    <Label className="text-sm">Split by</Label>
                    <Select
                      value={draft.splitColumn}
                      onValueChange={(v) => setDraft({ ...draft, splitColumn: v, splitRows: [] })}
                    >
                      <SelectTrigger className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {groupBy.map((g) => (
                          <SelectItem key={g} value={g}>
                            {labelFor(g)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button variant="outline" onClick={run(loadGroups)} disabled={loadingGroups || !draft.splitColumn}>
                    {loadingGroups ? <Spinner className="h-4 w-4 mr-1" /> : null}
                    Load groups
                  </Button>
                </div>

                {draft.splitRows.length > 0 ? (
                  <div className="space-y-1.5 max-h-80 overflow-auto pr-1">
                    <div className="text-xs text-muted-foreground">
                      Enter recipients for each group. Leave a group blank to skip it.
                    </div>
                    {draft.splitRows.map((row, i) => (
                      <div key={row.value ?? `__null_${i}`} className="grid grid-cols-3 gap-2 items-center">
                        <div className="text-sm font-mono truncate" title={row.value ?? '(blank)'}>
                          {row.value ?? '(blank)'}
                        </div>
                        <Input
                          className="col-span-2 h-8 text-sm"
                          placeholder="team@example.com, lead@example.com"
                          value={row.recipients}
                          onChange={(e) => {
                            const next = [...draft.splitRows];
                            next[i] = { ...next[i], recipients: e.target.value };
                            setDraft({ ...draft, splitRows: next });
                          }}
                        />
                      </div>
                    ))}
                    <div className="text-xs text-muted-foreground">
                      {mappedCount} of {draft.splitRows.length} groups will receive email.
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Click <em>Load groups</em> to list the values of {labelFor(draft.splitColumn)} and
                    assign recipients.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-sm">Subject (optional)</Label>
              <Input
                placeholder="Defaults to the report name"
                value={draft.subject}
                onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-sm">Frequency</Label>
                <Select
                  value={draft.frequency}
                  onValueChange={(v) => setDraft({ ...draft, frequency: v as Frequency })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="cron">Advanced (cron)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Timezone</Label>
                <Select value={draft.timezone} onValueChange={(v) => setDraft({ ...draft, timezone: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {timezoneOptions().map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {draft.frequency === 'cron' ? (
              <div className="space-y-1.5">
                <Label className="text-sm">Cron expression</Label>
                <Input
                  className="font-mono"
                  placeholder="0 8 * * 1"
                  value={draft.cron}
                  onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  5 fields: minute hour day-of-month month day-of-week.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-3 items-end">
                {draft.frequency === 'weekly' && (
                  <div className="space-y-1.5">
                    <Label className="text-sm">Day</Label>
                    <Select
                      value={String(draft.weekday)}
                      onValueChange={(v) => setDraft({ ...draft, weekday: Number(v) })}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEEKDAYS.map((d, i) => (
                          <SelectItem key={d} value={String(i)}>
                            {d}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {draft.frequency === 'monthly' && (
                  <div className="space-y-1.5">
                    <Label className="text-sm">Day of month</Label>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      className="w-24"
                      value={draft.dayOfMonth}
                      onChange={(e) => setDraft({ ...draft, dayOfMonth: Number(e.target.value) })}
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label className="text-sm">Time</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      className="w-16"
                      value={draft.hour}
                      onChange={(e) => setDraft({ ...draft, hour: Number(e.target.value) })}
                    />
                    <span>:</span>
                    <Input
                      type="number"
                      min={0}
                      max={59}
                      className="w-16"
                      value={draft.minute}
                      onChange={(e) => setDraft({ ...draft, minute: Number(e.target.value) })}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button onClick={run(createSchedule)} disabled={busy}>
                {busy ? <Spinner className="h-4 w-4 mr-1" /> : null}
                Create schedule
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowForm(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" onClick={() => setShowForm(true)} disabled={!canSend}>
            <Plus className="h-4 w-4 mr-1" /> Add schedule
          </Button>
        )}
        {!canSend && (
          <p className="text-xs text-muted-foreground">
            Finish configuring the report (table + columns) to enable scheduling.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
