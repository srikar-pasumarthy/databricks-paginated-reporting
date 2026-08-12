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
} from '@databricks/appkit-ui/react';
import { Mail, Plus, Trash2, Send, Clock } from 'lucide-react';
import { api, type Schedule, type SchedulesResponse, type Frequency } from '../lib/api';
import { run } from '../lib/utils';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A small set of common timezones + the viewer's local zone. */
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

interface DraftState {
  recipients: string;
  subject: string;
  frequency: Frequency;
  weekday: number;
  dayOfMonth: number;
  hour: number;
  minute: number;
  cron: string;
  timezone: string;
}

function emptyDraft(): DraftState {
  return {
    recipients: '',
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

export function SchedulePanel({ reportId, canSend }: { reportId: string; canSend: boolean }) {
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<DraftState>(emptyDraft());

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

  const specFromDraft = (d: DraftState) => ({
    recipients: d.recipients
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    subject: d.subject,
    frequency: d.frequency,
    weekday: d.weekday,
    dayOfMonth: d.dayOfMonth,
    hour: d.hour,
    minute: d.minute,
    cron: d.cron,
    timezone: d.timezone,
  });

  const createSchedule = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/reports/${reportId}/schedules`, specFromDraft(draft));
      setShowForm(false);
      setDraft(emptyDraft());
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
      const res = await api.post<{ status: string; row_count: number }>(
        `/api/reports/${reportId}/send-now`,
        { recipients: s.recipients, subject: s.subject, body: s.body },
      );
      setNotice(
        res.status === 'preview'
          ? `Preview only (no SMTP configured): rendered ${res.row_count.toLocaleString()} rows and logged the send to ${s.recipients.join(', ')}.`
          : `Sent to ${s.recipients.join(', ')}.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4" /> Email schedule
        </CardTitle>
        <CardDescription>
          Email this report as a PDF to recipients on a recurring schedule.
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
                <div className="text-xs text-muted-foreground pl-6">
                  To: {s.recipients.join(', ')}
                  {!s.enabled && <Badge variant="outline" className="ml-2">paused</Badge>}
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
          <div className="rounded-md border p-4 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm">Recipients</Label>
              <Input
                placeholder="alice@example.com, bob@example.com"
                value={draft.recipients}
                onChange={(e) => setDraft({ ...draft, recipients: e.target.value })}
              />
            </div>
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
                <Select
                  value={draft.timezone}
                  onValueChange={(v) => setDraft({ ...draft, timezone: v })}
                >
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

            {/* Cadence detail */}
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
