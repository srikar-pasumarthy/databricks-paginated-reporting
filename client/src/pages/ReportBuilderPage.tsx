import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
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
  RadioGroup,
  RadioGroupItem,
} from '@databricks/appkit-ui/react';
import { ArrowLeft, ChevronRight, Table2, Play, FileDown, GripVertical } from 'lucide-react';
import {
  api,
  type Report,
  type ReportColumn,
  type Aggregation,
  type UcColumn,
  type ReportView,
} from '../lib/api';
import { run } from '../lib/utils';
import { SchedulePanel } from './SchedulePanel';

/** Aggregations offered per column type. */
function aggsFor(type: ReportColumn['type']): Aggregation[] {
  if (type === 'number') return ['none', 'sum', 'avg', 'min', 'max', 'count'];
  return ['none', 'count'];
}

/** Heuristic default aggregation for a newly added numeric column. */
function defaultAgg(col: UcColumn): Aggregation {
  if (col.field.type !== 'number') return 'none';
  const n = col.name.toLowerCase();
  if (/(rate|ratio|pct|percent|score|avg|average|per_)/.test(n)) return 'avg';
  return 'sum';
}

const AGG_LABELS: Record<Aggregation, string> = {
  none: 'No summary',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  count: 'Count',
};

export function ReportBuilderPage() {
  const { reportId } = useParams();
  const navigate = useNavigate();
  const [report, setReport] = useState<Report | null>(null);
  const [ucColumns, setUcColumns] = useState<UcColumn[]>([]);
  const [preview, setPreview] = useState<ReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const loadColumns = useCallback(async (fullName: string) => {
    const res = await api.get<{ columns: UcColumn[] }>(
      `/api/uc/columns?full_name=${encodeURIComponent(fullName)}`,
    );
    setUcColumns(res.columns);
  }, []);

  const load = useCallback(async () => {
    const r = await api.get<Report>(`/api/reports/${reportId}`);
    setReport(r);
    setNameDraft(r.name);
    if (r.source_table) await loadColumns(r.source_table);
  }, [reportId, loadColumns]);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  /** PATCH the report and adopt the server's canonical response. */
  const save = async (patch: Partial<Report>): Promise<Report | null> => {
    if (!report) return null;
    setError(null);
    try {
      const updated = await api.patch<Report>(`/api/reports/${report.id}`, patch);
      setReport(updated);
      setPreview(null);
      return updated;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const selectTable = async (fullName: string) => {
    setBusy(true);
    const updated = await save({ source_table: fullName, columns: [], group_by: [] });
    if (updated) await loadColumns(fullName).catch(() => setUcColumns([]));
    setBusy(false);
  };

  const toggleColumn = (uc: UcColumn) => {
    if (!report) return;
    const exists = report.columns.some((c) => c.name === uc.name);
    let cols: ReportColumn[];
    if (exists) {
      cols = report.columns.filter((c) => c.name !== uc.name);
    } else {
      const added: ReportColumn = {
        name: uc.name,
        label: uc.name,
        type: uc.field.type as ReportColumn['type'],
        agg: defaultAgg(uc),
      };
      cols = [...report.columns, added];
    }
    // Re-order to match UC column order for stable presentation.
    const order = new Map(ucColumns.map((c, i) => [c.name, i]));
    cols.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
    const group_by = report.group_by.filter((g) => cols.some((c) => c.name === g));
    run(() => save({ columns: cols, group_by }).then(() => {}))();
  };

  const updateColumn = (name: string, patch: Partial<ReportColumn>) => {
    if (!report) return;
    const cols = report.columns.map((c) => (c.name === name ? { ...c, ...patch } : c));
    run(() => save({ columns: cols }).then(() => {}))();
  };

  const toggleGroup = (name: string) => {
    if (!report) return;
    const isGroup = report.group_by.includes(name);
    const group_by = isGroup
      ? report.group_by.filter((g) => g !== name)
      : [...report.group_by, name];
    run(() => save({ group_by }).then(() => {}))();
  };

  const moveGroup = (name: string, dir: -1 | 1) => {
    if (!report) return;
    const gb = [...report.group_by];
    const i = gb.indexOf(name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= gb.length) return;
    [gb[i], gb[j]] = [gb[j], gb[i]];
    run(() => save({ group_by: gb }).then(() => {}))();
  };

  const commitName = () => {
    if (report && nameDraft.trim() && nameDraft.trim() !== report.name) {
      run(() => save({ name: nameDraft.trim() }).then(() => {}))();
    }
  };

  const runPreview = async () => {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.post<ReportView>(`/api/reports/${report.id}/preview`, { limit: 1000 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const downloadPdf = () => {
    if (!report) return;
    window.open(`/api/reports/${report.id}/pdf`, '_blank');
  };

  if (!report) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  const selectedNames = new Set(report.columns.map((c) => c.name));
  const canPreview = !!report.source_table && report.columns.length > 0;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => void navigate('/')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Input
          className="flex-1 text-lg font-semibold"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <Button onClick={downloadPdf} disabled={!canPreview}>
          <FileDown className="h-4 w-4 mr-1" />
          Download PDF
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Step 1 + 2: table + columns */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Table2 className="h-4 w-4" /> 1. Choose a table
            </CardTitle>
            <CardDescription>{report.source_table ?? 'No table selected yet.'}</CardDescription>
          </CardHeader>
          <CardContent>
            <CatalogBrowser
              selected={report.source_table ?? undefined}
              onSelect={(fn) => run(() => selectTable(fn))()}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Pick columns to keep</CardTitle>
            <CardDescription>Check the columns to include in the report.</CardDescription>
          </CardHeader>
          <CardContent>
            {!report.source_table ? (
              <p className="text-sm text-muted-foreground">Select a table first.</p>
            ) : ucColumns.length === 0 ? (
              <Spinner />
            ) : (
              <div className="space-y-1 max-h-96 overflow-auto">
                {ucColumns.map((c) => (
                  <label
                    key={c.name}
                    className="flex items-center gap-2 py-1 text-sm cursor-pointer"
                  >
                    <Checkbox
                      checked={selectedNames.has(c.name)}
                      onCheckedChange={() => toggleColumn(c)}
                    />
                    <span className="font-mono">{c.name}</span>
                    <span className="text-xs text-muted-foreground">{c.type_text}</span>
                  </label>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Step 3: grouping */}
      {report.columns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">3. Group &amp; break by</CardTitle>
            <CardDescription>
              Choose one or more columns to group by. Each group gets its own section and a summary
              row; nesting order is top to bottom.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Ordered active groups */}
            {report.group_by.length > 0 && (
              <div className="space-y-1">
                {report.group_by.map((g, idx) => {
                  const col = report.columns.find((c) => c.name === g);
                  return (
                    <div
                      key={g}
                      className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5"
                    >
                      <GripVertical className="h-4 w-4 text-muted-foreground" />
                      <Badge variant="secondary">{idx + 1}</Badge>
                      <span className="flex-1 font-medium text-sm">{col?.label ?? g}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={idx === 0}
                        onClick={() => moveGroup(g, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={idx === report.group_by.length - 1}
                        onClick={() => moveGroup(g, 1)}
                      >
                        ↓
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => toggleGroup(g)}>
                        Remove
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {report.columns
                .filter((c) => !report.group_by.includes(c.name))
                .map((c) => (
                  <Button
                    key={c.name}
                    size="sm"
                    variant="outline"
                    onClick={() => toggleGroup(c.name)}
                  >
                    + {c.label}
                  </Button>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 4: per-column summary config */}
      {report.columns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">4. Summary row</CardTitle>
            <CardDescription>
              Pick how each column is summarized at group breaks and in the grand total. Only numeric
              columns can be summed or averaged.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {report.columns.map((c) => (
                <div key={c.name} className="grid grid-cols-12 items-center gap-2">
                  <div className="col-span-4 flex items-center gap-2 min-w-0">
                    <span className="font-mono text-sm truncate">{c.name}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {c.type}
                    </Badge>
                  </div>
                  <div className="col-span-4">
                    <Input
                      value={c.label}
                      onChange={(e) => updateColumn(c.name, { label: e.target.value })}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="col-span-4">
                    <Select
                      value={c.agg}
                      onValueChange={(v) => updateColumn(c.name, { agg: v as Aggregation })}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {aggsFor(c.type).map((a) => (
                          <SelectItem key={a} value={a}>
                            {AGG_LABELS[a]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Page options */}
      {report.columns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Page options</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-8">
            <div className="space-y-2">
              <Label className="text-sm">Page size</Label>
              <RadioGroup
                value={report.page_size}
                onValueChange={(v) => run(() => save({ page_size: v as Report['page_size'] }).then(() => {}))()}
                className="flex gap-4"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="A4" /> A4
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="Letter" /> Letter
                </label>
              </RadioGroup>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Orientation</Label>
              <RadioGroup
                value={report.orientation}
                onValueChange={(v) =>
                  run(() => save({ orientation: v as Report['orientation'] }).then(() => {}))()
                }
                className="flex gap-4"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="portrait" /> Portrait
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="landscape" /> Landscape
                </label>
              </RadioGroup>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Preview */}
      {report.columns.length > 0 && (
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={run(runPreview)} disabled={busy || !canPreview}>
            <Play className="h-4 w-4 mr-1" />
            Preview
          </Button>
          {busy && <Spinner />}
        </div>
      )}

      {preview && <PreviewTable view={preview} />}

      {/* Email scheduling */}
      {report.columns.length > 0 && <SchedulePanel reportId={report.id} canSend={canPreview} />}
    </div>
  );
}

/** Renders the banded preview: group headers, detail rows, summary + grand-total bands. */
function PreviewTable({ view }: { view: ReportView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Preview{' '}
          <span className="text-muted-foreground font-normal text-sm">
            ({view.rowCount.toLocaleString()} rows total)
          </span>
        </CardTitle>
        <CardDescription>
          {view.detailTruncated
            ? `Showing the first ${view.detailShown.toLocaleString()} detail rows. Subtotals and the grand total are computed over the full ${view.rowCount.toLocaleString()} rows.`
            : `Subtotals and the grand total are computed over the full table.`}{' '}
          The PDF renders up to 50,000 detail rows; group summaries are always exact.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="text-xs border-collapse w-full">
          <thead>
            <tr>
              {view.columns.map((c) => (
                <th
                  key={c.name}
                  className={`border px-2 py-1 bg-primary text-primary-foreground ${
                    c.type === 'number' ? 'text-right' : 'text-left'
                  }`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.lines.map((line, i) => {
              if (line.type === 'group-header') {
                return (
                  <tr key={i} className="bg-muted">
                    <td
                      colSpan={view.columns.length}
                      className="border px-2 py-1 font-medium"
                      style={{ paddingLeft: `${8 + line.level * 16}px` }}
                    >
                      <span className="text-muted-foreground">{line.label}: </span>
                      <span className="font-semibold">{line.value}</span>
                    </td>
                  </tr>
                );
              }
              if (line.type === 'detail') {
                return (
                  <tr key={i}>
                    {line.cells.map((v, ci) => (
                      <td
                        key={ci}
                        className={`border px-2 py-1 ${
                          view.columns[ci]?.type === 'number' ? 'text-right' : 'text-left'
                        }`}
                      >
                        {v}
                      </td>
                    ))}
                  </tr>
                );
              }
              // summary + grand-total
              const grand = line.type === 'grand-total';
              return (
                <tr key={i} className={grand ? 'bg-primary/90 text-primary-foreground' : 'bg-secondary'}>
                  {view.columns.map((c, ci) => {
                    const cell = line.cells[ci];
                    if (cell !== null && c.agg !== 'none') {
                      return (
                        <td key={ci} className="border px-2 py-1 text-right font-semibold">
                          <span className="opacity-70 mr-1">{aggShort(c.agg)}</span>
                          {cell}
                        </td>
                      );
                    }
                    if (ci === firstNonAgg(view)) {
                      return (
                        <td key={ci} className="border px-2 py-1 font-semibold italic">
                          {line.label} ({line.count.toLocaleString()} rows)
                        </td>
                      );
                    }
                    return <td key={ci} className="border px-2 py-1" />;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function aggShort(agg: Aggregation): string {
  return AGG_LABELS[agg];
}

/** Index of the first column with no aggregation (where the band label goes). */
function firstNonAgg(view: ReportView): number {
  const idx = view.columns.findIndex((c) => c.agg === 'none');
  return idx === -1 ? 0 : idx;
}

/** Drill-down UC browser: catalogs → schemas → tables. */
function CatalogBrowser({
  selected,
  onSelect,
}: {
  selected?: string;
  onSelect: (fullName: string) => void;
}) {
  const [catalog, setCatalog] = useState<string | null>(null);
  const [schema, setSchema] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<{ name: string }[]>([]);
  const [schemas, setSchemas] = useState<{ name: string }[]>([]);
  const [tables, setTables] = useState<{ name: string; full_name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .get<{ name: string }[]>('/api/uc/catalogs')
      .then(setCatalogs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const openCatalog = async (name: string) => {
    setCatalog(name);
    setSchema(null);
    setTables([]);
    setLoading(true);
    setError(null);
    try {
      setSchemas(await api.get(`/api/uc/schemas?catalog=${encodeURIComponent(name)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const openSchema = async (name: string) => {
    setSchema(name);
    setLoading(true);
    setError(null);
    try {
      setTables(
        await api.get(
          `/api/uc/tables?catalog=${encodeURIComponent(catalog!)}&schema=${encodeURIComponent(name)}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-sm flex-wrap">
        <button
          className="hover:underline"
          onClick={() => {
            setCatalog(null);
            setSchema(null);
          }}
        >
          Catalogs
        </button>
        {catalog && (
          <>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <button className="hover:underline" onClick={() => run(() => openCatalog(catalog))()}>
              {catalog}
            </button>
          </>
        )}
        {schema && (
          <>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <span>{schema}</span>
          </>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading && <Spinner />}

      <div className="max-h-72 overflow-auto space-y-0.5">
        {!catalog &&
          catalogs.map((c) => (
            <BrowserRow key={c.name} label={c.name} onClick={() => run(() => openCatalog(c.name))()} chevron />
          ))}
        {catalog &&
          !schema &&
          schemas.map((s) => (
            <BrowserRow key={s.name} label={s.name} onClick={() => run(() => openSchema(s.name))()} chevron />
          ))}
        {schema &&
          tables.map((t) => (
            <BrowserRow
              key={t.full_name}
              label={t.name}
              active={selected === t.full_name}
              onClick={() => onSelect(t.full_name)}
            />
          ))}
      </div>
    </div>
  );
}

function BrowserRow({
  label,
  onClick,
  chevron,
  active,
}: {
  label: string;
  onClick: () => void;
  chevron?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-sm text-left hover:bg-muted ${
        active ? 'bg-primary/10 text-primary font-medium' : ''
      }`}
    >
      <span className="font-mono truncate">{label}</span>
      {chevron && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
    </button>
  );
}
