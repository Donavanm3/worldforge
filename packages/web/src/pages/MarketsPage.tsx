import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.js';
import type { Company, CompanyOrder, Item, MarketTrade, OrderBook } from '../api/types.js';
import { Alert, Button, Card, Spinner } from '../components/ui.js';
import { formatMoney, titleCase } from '../lib/format.js';

export function MarketsPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [itemId, setItemId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [book, setBook] = useState<OrderBook | null>(null);
  const [trades, setTrades] = useState<MarketTrade[]>([]);
  const [orders, setOrders] = useState<CompanyOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [quantity, setQuantity] = useState('10');
  const [price, setPrice] = useState('');

  useEffect(() => {
    Promise.all([api.items(), api.myCompanies()])
      .then(([allItems, mine]) => {
        setItems(allItems);
        setCompanies(mine);
        setItemId((current) => current || (allItems[0]?.id ?? ''));
        setCompanyId((current) => current || (mine[0]?.id ?? ''));
        setPrice((current) => current || (allItems[0]?.base_price ?? ''));
      })
      .catch(() => {
        setError('Could not load the market.');
        setItems([]);
      });
  }, []);

  const reload = useCallback(async () => {
    if (!itemId) return;
    const [nextBook, nextTrades] = await Promise.all([
      api.orderBook(itemId),
      api.itemTrades(itemId),
    ]);
    setBook(nextBook);
    setTrades(nextTrades);
    if (companyId) setOrders(await api.companyOrders(companyId));
  }, [itemId, companyId]);

  useEffect(() => {
    void reload().catch(() => setError('Could not load the order book.'));
  }, [reload]);

  const selectedItem = items?.find((i) => i.id === itemId) ?? null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.placeOrder({ companyId, itemId, side, quantity, price });
      setNotice(
        Number(result.filledQuantity) > 0
          ? `Filled ${result.filledQuantity} for ${formatMoney(result.totalValue)}` +
              (Number(result.remainingQuantity) > 0
                ? `; ${result.remainingQuantity} still resting.`
                : '.')
          : 'Order resting on the book.',
      );
      await reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not place the order.');
    } finally {
      setBusy(false);
    }
  };

  if (items === null) return <Spinner />;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold">Markets</h1>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}

      {companies.length === 0 && (
        <Alert tone="info">You need a company before you can trade. Found one first.</Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Card title="Commodities">
          <ul className="max-h-[28rem] space-y-1 overflow-auto">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  onClick={() => {
                    setItemId(item.id);
                    setPrice(item.base_price);
                  }}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm transition ${
                    item.id === itemId
                      ? 'bg-ink-600 text-slate-100'
                      : 'text-slate-400 hover:bg-ink-700'
                  }`}
                >
                  <div className="flex justify-between">
                    <span>{item.name}</span>
                    <span className="font-mono text-xs">{formatMoney(item.base_price)}</span>
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">
                    Tier {item.tier} · {titleCase(item.kind)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-4">
          <Card title={selectedItem ? `Trade ${selectedItem.name}` : 'Trade'}>
            <div className="flex flex-wrap items-end gap-2">
              <label>
                <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">
                  Company
                </span>
                <select
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                  className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-slate-100"
                >
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex overflow-hidden rounded-md border border-ink-600">
                {(['buy', 'sell'] as const).map((value) => (
                  <button
                    key={value}
                    onClick={() => setSide(value)}
                    className={`px-4 py-2 text-sm ${
                      side === value
                        ? value === 'buy'
                          ? 'bg-gain/80 text-ink-900'
                          : 'bg-loss/80 text-ink-900'
                        : 'bg-ink-700 text-slate-300'
                    }`}
                  >
                    {titleCase(value)}
                  </button>
                ))}
              </div>

              <label>
                <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">
                  Quantity
                </span>
                <input
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  inputMode="decimal"
                  className="w-28 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-right font-mono"
                />
              </label>
              <label>
                <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">
                  Limit price
                </span>
                <input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  inputMode="decimal"
                  className="w-28 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-right font-mono"
                />
              </label>

              <Button loading={busy} disabled={!companyId} onClick={() => void submit()}>
                Place order
              </Button>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Orders execute at the resting price, so a buy above the best ask pays the ask. Selling
              escrows the goods; buying escrows the cash.
            </p>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Order book">
              {book === null ? (
                <Spinner />
              ) : (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="mb-1 text-xs uppercase tracking-widest text-gain">Bids</div>
                    {book.bids.length === 0 ? (
                      <p className="text-xs text-slate-500">None</p>
                    ) : (
                      book.bids.slice(0, 8).map((entry) => (
                        <div key={entry.id} className="flex justify-between font-mono text-xs">
                          <span className="text-gain">{formatMoney(entry.price)}</span>
                          <span className="text-slate-400">{Number(entry.remaining)}</span>
                        </div>
                      ))
                    )}
                  </div>
                  <div>
                    <div className="mb-1 text-xs uppercase tracking-widest text-loss">Asks</div>
                    {book.asks.length === 0 ? (
                      <p className="text-xs text-slate-500">None</p>
                    ) : (
                      book.asks.slice(0, 8).map((entry) => (
                        <div key={entry.id} className="flex justify-between font-mono text-xs">
                          <span className="text-loss">{formatMoney(entry.price)}</span>
                          <span className="text-slate-400">{Number(entry.remaining)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </Card>

            <Card title="Recent trades">
              {trades.length === 0 ? (
                <p className="text-sm text-slate-400">No trades yet.</p>
              ) : (
                <div className="space-y-1 text-xs">
                  {trades.slice(0, 10).map((trade) => (
                    <div key={trade.id} className="flex justify-between font-mono">
                      <span>{Number(trade.quantity)}</span>
                      <span className="text-slate-300">{formatMoney(trade.price)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card title="Your orders">
            {orders.length === 0 ? (
              <p className="py-4 text-sm text-slate-400">No orders.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-widest text-slate-500">
                    <th className="pb-2">Item</th>
                    <th className="pb-2">Side</th>
                    <th className="pb-2 text-right">Remaining</th>
                    <th className="pb-2 text-right">Price</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-700">
                  {orders.slice(0, 15).map((order) => (
                    <tr key={order.id}>
                      <td className="py-2">{order.item_name}</td>
                      <td className={`py-2 ${order.side === 'buy' ? 'text-gain' : 'text-loss'}`}>
                        {titleCase(order.side)}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {Number(order.remaining)} / {Number(order.quantity)}
                      </td>
                      <td className="py-2 text-right font-mono">{formatMoney(order.price)}</td>
                      <td className="py-2 text-slate-400">{titleCase(order.status)}</td>
                      <td className="py-2 text-right">
                        {order.status === 'open' && (
                          <Button
                            variant="secondary"
                            loading={busy}
                            onClick={() =>
                              void api
                                .cancelOrder(order.id)
                                .then(reload)
                                .catch(() => setError('Could not cancel that order.'))
                            }
                          >
                            Cancel
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
