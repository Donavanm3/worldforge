import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.js';
import type { JobListing, MyEmployment } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import { Alert, Button, Card, Spinner, Stat } from '../components/ui.js';
import { formatMoney, titleCase } from '../lib/format.js';

export function JobsPage() {
  const { refresh } = useAuth();
  const [listings, setListings] = useState<JobListing[] | null>(null);
  const [employment, setEmployment] = useState<MyEmployment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [jobs, mine] = await Promise.all([api.jobs(), api.myJob()]);
      setListings(jobs);
      setEmployment(mine);
    } catch {
      setError('Could not load the job market.');
      setListings([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all([load(), refresh()]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold">Jobs</h1>
      {error && <Alert>{error}</Alert>}

      {employment ? (
        <Card
          title="Your position"
          action={
            <Button variant="secondary" loading={busy} onClick={() => void run(() => api.resign())}>
              Resign
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Employer" value={employment.company_name} />
            <Stat label="Role" value={employment.title} />
            <Stat
              label="Salary"
              value={formatMoney(employment.salary)}
              hint="Paid when your employer runs payroll"
            />
          </div>
        </Card>
      ) : (
        <Card title="Your position">
          <p className="py-4 text-sm text-slate-400">
            You are not employed. Take a job below for steady income, or found your own company.
          </p>
        </Card>
      )}

      <Card title="Open positions">
        {listings === null ? (
          <Spinner />
        ) : listings.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">
            Nobody is hiring right now. Companies post jobs from their Staff tab.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-widest text-slate-500">
                <th className="pb-2">Role</th>
                <th className="pb-2">Company</th>
                <th className="pb-2">Industry</th>
                <th className="pb-2 text-right">Seats</th>
                <th className="pb-2 text-right">Salary</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700">
              {listings.map((listing) => (
                <tr key={listing.id}>
                  <td className="py-3">{listing.title}</td>
                  <td className="py-3 text-slate-300">{listing.company_name}</td>
                  <td className="py-3 text-slate-400">{titleCase(listing.industry)}</td>
                  <td className="py-3 text-right text-slate-400">
                    {listing.positions - listing.filled} / {listing.positions}
                  </td>
                  <td className="py-3 text-right font-mono text-gain">
                    {formatMoney(listing.salary)}
                  </td>
                  <td className="py-3 text-right">
                    <Button
                      loading={busy}
                      disabled={Boolean(employment)}
                      onClick={() => void run(() => api.applyForJob(listing.id))}
                    >
                      {employment ? 'Employed' : 'Accept'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
