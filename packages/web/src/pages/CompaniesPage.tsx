import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api/client.js';
import type { Company, InventoryRow, ProductionRun, Recipe } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import { Alert, Button, Card, Field, Spinner, Stat } from '../components/ui.js';
import { formatMoney, titleCase } from '../lib/format.js';

const INDUSTRIES = [
  'agriculture',
  'mining',
  'oil_and_gas',
  'energy',
  'manufacturing',
  'construction',
  'transportation',
  'logistics',
  'retail',
  'restaurants',
  'finance',
  'technology',
  'software',
  'telecommunications',
  'healthcare',
  'entertainment',
  'media',
  'real_estate',
];

type Tab = 'inventory' | 'production' | 'staff';

export function CompaniesPage() {
  const { refresh } = useAuth();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const mine = await api.myCompanies();
      setCompanies(mine);
      setSelectedId((current) => current ?? mine[0]?.id ?? null);
    } catch {
      setError('Could not load your companies.');
      setCompanies([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = companies?.find((c) => c.id === selectedId) ?? null;

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
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold">Companies</h1>
      {error && <Alert>{error}</Alert>}

      {companies === null ? (
        <Spinner />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <div className="space-y-4">
            <Card title="Your companies">
              {companies.length === 0 ? (
                <p className="text-sm text-slate-400">You have not founded a company yet.</p>
              ) : (
                <ul className="space-y-1">
                  {companies.map((company) => (
                    <li key={company.id}>
                      <button
                        onClick={() => setSelectedId(company.id)}
                        className={`w-full rounded-md px-3 py-2 text-left text-sm transition ${
                          company.id === selectedId
                            ? 'bg-ink-600 text-slate-100'
                            : 'text-slate-400 hover:bg-ink-700'
                        }`}
                      >
                        <div>{company.name}</div>
                        <div className="font-mono text-xs text-gain">
                          {formatMoney(company.cash)}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <FoundCompanyCard
              busy={busy}
              onSubmit={(input) => run(() => api.createCompany(input))}
            />
          </div>

          {selected ? (
            <CompanyDetail company={selected} busy={busy} run={run} />
          ) : (
            <Card>
              <p className="py-8 text-center text-sm text-slate-400">
                Found a company to begin producing and trading.
              </p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function FoundCompanyCard({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: { name: string; industry: string; initialCapital?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('manufacturing');
  const [capital, setCapital] = useState('2000.00');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ name, industry, initialCapital: capital || undefined });
    setName('');
  };

  return (
    <Card title="Found a company">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">
            Industry
          </span>
          <select
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            className="w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-slate-100"
          >
            {INDUSTRIES.map((value) => (
              <option key={value} value={value}>
                {titleCase(value)}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Starting capital"
          value={capital}
          inputMode="decimal"
          onChange={(e) => setCapital(e.target.value)}
        />
        <p className="text-xs text-slate-500">
          Incorporation costs {formatMoney('500')} plus whatever capital you commit.
        </p>
        <Button type="submit" loading={busy} className="w-full">
          Incorporate
        </Button>
      </form>
    </Card>
  );
}

function CompanyDetail({
  company,
  busy,
  run,
}: {
  company: Company;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('inventory');
  const [amount, setAmount] = useState('500.00');

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Treasury" value={formatMoney(company.cash)} />
        <Stat label="Industry" value={titleCase(company.industry)} />
        <Stat label="Reputation" value={company.reputation} />
      </div>

      <Card title="Treasury">
        <div className="flex flex-wrap items-end gap-2">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="w-36 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-right font-mono"
          />
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => void run(() => api.treasury(company.id, 'deposit', amount))}
          >
            Deposit
          </Button>
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => void run(() => api.treasury(company.id, 'withdraw', amount))}
          >
            Withdraw
          </Button>
        </div>
      </Card>

      <div className="flex gap-1 border-b border-ink-600">
        {(['inventory', 'production', 'staff'] as Tab[]).map((value) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`px-4 py-2 text-sm transition ${
              tab === value
                ? 'border-b-2 border-accent-500 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {titleCase(value)}
          </button>
        ))}
      </div>

      {tab === 'inventory' && <InventoryTab companyId={company.id} />}
      {tab === 'production' && <ProductionTab companyId={company.id} busy={busy} run={run} />}
      {tab === 'staff' && <StaffTab companyId={company.id} busy={busy} run={run} />}
    </div>
  );
}

function InventoryTab({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<InventoryRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    api
      .companyInventory(companyId)
      .then(setRows)
      .catch(() => setRows([]));
  }, [companyId]);

  if (rows === null) return <Spinner />;
  if (rows.length === 0) {
    return (
      <Card>
        <p className="py-6 text-center text-sm text-slate-400">
          No stock. Produce something or buy it on the market.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-widest text-slate-500">
            <th className="pb-2">Item</th>
            <th className="pb-2">Kind</th>
            <th className="pb-2 text-right">Quantity</th>
            <th className="pb-2 text-right">Base value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-700">
          {rows.map((row) => (
            <tr key={row.item_id}>
              <td className="py-2">{row.name}</td>
              <td className="py-2 text-slate-400">{titleCase(row.kind)}</td>
              <td className="py-2 text-right font-mono">
                {Number(row.quantity).toLocaleString()} {row.unit}
              </td>
              <td className="py-2 text-right font-mono text-slate-400">
                {formatMoney(Number(row.quantity) * Number(row.base_price), { compact: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ProductionTab({
  companyId,
  busy,
  run,
}: {
  companyId: string;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [runs, setRuns] = useState<ProductionRun[] | null>(null);
  const [recipeId, setRecipeId] = useState('');
  const [batches, setBatches] = useState('1');

  const reload = useCallback(() => {
    api
      .production(companyId)
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [companyId]);

  useEffect(() => {
    api
      .recipes()
      .then((all) => {
        setRecipes(all);
        setRecipeId((current) => current || (all[0]?.id ?? ''));
      })
      .catch(() => setRecipes([]));
  }, []);

  useEffect(reload, [reload]);

  const selected = recipes?.find((r) => r.id === recipeId);

  return (
    <div className="space-y-4">
      <Card title="Start a production run">
        {recipes === null ? (
          <Spinner />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex-1">
                <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">
                  Recipe
                </span>
                <select
                  value={recipeId}
                  onChange={(e) => setRecipeId(e.target.value)}
                  className="w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-slate-100"
                >
                  {recipes.map((recipe) => (
                    <option key={recipe.id} value={recipe.id}>
                      {recipe.output_name} ×{Number(recipe.output_quantity)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">
                  Batches
                </span>
                <input
                  value={batches}
                  onChange={(e) => setBatches(e.target.value)}
                  inputMode="numeric"
                  className="w-24 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-right font-mono"
                />
              </label>
              <Button
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    await api.startProduction(companyId, recipeId, Number(batches) || 1);
                    reload();
                  })
                }
              >
                Produce
              </Button>
            </div>

            {selected && (
              <p className="text-xs text-slate-500">
                {selected.inputs.length === 0
                  ? 'Extraction — no inputs, labour only.'
                  : `Consumes per batch: ${selected.inputs
                      .map((i) => `${Number(i.quantity)} ${i.item_name}`)
                      .join(', ')}`}{' '}
                · {Number(selected.labour_hours)} labour-hours
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="Runs">
        {runs === null ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">Nothing in production.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-widest text-slate-500">
                <th className="pb-2">Output</th>
                <th className="pb-2">Batches</th>
                <th className="pb-2">Status</th>
                <th className="pb-2 text-right">Wages</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700">
              {runs.slice(0, 15).map((item) => (
                <tr key={item.id}>
                  <td className="py-2">
                    {item.output_name} ×{Number(item.output_quantity) * item.batches}
                  </td>
                  <td className="py-2 text-slate-400">{item.batches}</td>
                  <td className="py-2">
                    <span className={item.status === 'completed' ? 'text-gain' : 'text-accent-400'}>
                      {titleCase(item.status)}
                    </span>
                  </td>
                  <td className="py-2 text-right font-mono text-slate-400">
                    {formatMoney(item.labour_cost)}
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

function StaffTab({
  companyId,
  busy,
  run,
}: {
  companyId: string;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [employees, setEmployees] = useState<Awaited<ReturnType<typeof api.employees>> | null>(
    null,
  );
  const [title, setTitle] = useState('Operator');
  const [salary, setSalary] = useState('250.00');
  const [positions, setPositions] = useState('1');
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .employees(companyId)
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [companyId]);

  useEffect(reload, [reload]);

  return (
    <div className="space-y-4">
      <Card title="Post a job">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <label>
            <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">
              Salary
            </span>
            <input
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              inputMode="decimal"
              className="w-28 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-right font-mono"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">
              Seats
            </span>
            <input
              value={positions}
              onChange={(e) => setPositions(e.target.value)}
              inputMode="numeric"
              className="w-20 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-right font-mono"
            />
          </label>
          <Button
            loading={busy}
            onClick={() =>
              void run(() =>
                api.createJobListing(companyId, {
                  title,
                  salary,
                  positions: Number(positions) || 1,
                }),
              )
            }
          >
            Post
          </Button>
        </div>
      </Card>

      <Card
        title="Employees"
        action={
          <Button
            variant="secondary"
            loading={busy}
            onClick={() =>
              void run(async () => {
                const result = await api.runPayroll(companyId);
                setNotice(
                  `Paid ${result.paid} of ${result.paid + result.unpaid} — ${formatMoney(result.total)}` +
                    (result.unpaid > 0 ? ' (treasury ran short)' : ''),
                );
              })
            }
          >
            Run payroll
          </Button>
        }
      >
        {notice && (
          <div className="mb-3">
            <Alert tone={notice.includes('short') ? 'error' : 'info'}>{notice}</Alert>
          </div>
        )}
        {employees === null ? (
          <Spinner />
        ) : employees.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">Nobody works here yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-widest text-slate-500">
                <th className="pb-2">Player</th>
                <th className="pb-2">Role</th>
                <th className="pb-2 text-right">Salary</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700">
              {employees.map((employee) => (
                <tr key={employee.id}>
                  <td className="py-2">{employee.username}</td>
                  <td className="py-2 text-slate-400">{employee.title}</td>
                  <td className="py-2 text-right font-mono">{formatMoney(employee.salary)}</td>
                  <td className="py-2 text-right">
                    <Button
                      variant="secondary"
                      loading={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.fireEmployee(companyId, employee.id);
                          reload();
                        })
                      }
                    >
                      Dismiss
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
