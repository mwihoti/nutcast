'use client';

import { QRCodeSVG } from 'qrcode.react';
import { Copy } from './Copy';

interface Row {
  label: string;
  value: string;
}

/**
 * A scannable code with the details under it, the way Lightning and Cashu
 * wallets show an invoice. `value` is what the QR encodes and what Copy copies.
 */
export function InvoiceQR({
  title,
  value,
  rows,
  copyLabel = 'Copy',
  uppercase = false,
}: {
  title: string;
  value: string;
  rows: Row[];
  copyLabel?: string;
  /** bolt11 is case-insensitive; upper case makes a smaller, easier-to-scan code. */
  uppercase?: boolean;
}) {
  return (
    <div className="invoice">
      <div className="invoice-title">{title}</div>
      <div className="qr">
        <QRCodeSVG
          value={uppercase ? value.toUpperCase() : value}
          size={512}
          level="M"
          marginSize={2}
          title={title}
          style={{ width: '100%', height: 'auto', display: 'block' }}
        />
      </div>
      <dl className="invoice-rows">
        {rows.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      <Copy text={value} label={copyLabel} />
    </div>
  );
}
