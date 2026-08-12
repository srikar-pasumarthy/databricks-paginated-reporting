import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Spinner,
  Alert,
  AlertDescription,
  Badge,
} from '@databricks/appkit-ui/react';
import { Plus, FileText, Trash2, ArrowRight } from 'lucide-react';
import { api, type ReportSummary } from '../lib/api';
import { run } from '../lib/utils';

export function ReportsListPage() {
  const navigate = useNavigate();
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setReports(await api.get<ReportSummary[]>('/api/reports'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const r = await api.post<ReportSummary>('/api/reports', { name: newName.trim() || 'Untitled report' });
      void navigate(`/reports/${r.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this report?')) return;
    setError(null);
    try {
      await api.del(`/api/reports/${id}`);
      setReports((rs) => rs.filter((r) => r.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reports</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Build a grouped, paginated report over a Unity Catalog table and export it to PDF.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New report</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="Report name (e.g. Monthly Occupancy by Hospital)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !creating) run(create)();
              }}
            />
            <Button onClick={run(create)} disabled={creating}>
              <Plus className="h-4 w-4 mr-1" />
              Create
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : reports.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">No reports yet. Create one above.</p>
      ) : (
        <div className="space-y-2">
          {reports.map((r) => (
            <button
              key={r.id}
              onClick={() => void navigate(`/reports/${r.id}`)}
              className="w-full text-left flex items-center gap-3 rounded-lg border px-4 py-3 hover:bg-muted transition-colors"
            >
              <FileText className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{r.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {r.source_table ?? 'No table selected'}
                  {r.group_by.length > 0 && (
                    <>
                      {' · grouped by '}
                      {r.group_by.join(', ')}
                    </>
                  )}
                </div>
              </div>
              {r.source_table && <Badge variant="secondary">ready</Badge>}
              <span
                role="button"
                tabIndex={0}
                className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  run(() => remove(r.id))();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    run(() => remove(r.id))();
                  }
                }}
              >
                <Trash2 className="h-4 w-4" />
              </span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
