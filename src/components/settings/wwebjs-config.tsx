'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, LogOut, QrCode, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Status = 'idle' | 'pending' | 'connected' | 'error';

export function WWebJSConfig() {
  const [status, setStatus] = useState<Status>('idle');
  const [phone, setPhone] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // On mount, check existing session status
  useEffect(() => {
    fetch('/api/whatsapp/wwebjs/session')
      .then((r) => r.json())
      .then((d) => {
        if (d.status === 'connected') {
          setStatus('connected');
          setPhone(d.phone ?? null);
        }
      })
      .catch(() => {});
  }, []);

  function startQR() {
    if (esRef.current) esRef.current.close();
    setQrDataUrl(null);
    setStatus('pending');

    const es = new EventSource('/api/whatsapp/wwebjs/qr');
    esRef.current = es;

    es.addEventListener('qr', async (e) => {
      try {
        const url = await QRCode.toDataURL(e.data, { width: 256, margin: 2 });
        setQrDataUrl(url);
      } catch {
        toast.error('Failed to render QR code');
      }
    });

    es.addEventListener('ready', (e) => {
      setStatus('connected');
      setPhone(e.data || null);
      setQrDataUrl(null);
      toast.success('WhatsApp Web connected!');
      es.close();
    });

    es.addEventListener('connected', (e) => {
      setStatus('connected');
      setPhone(e.data || null);
      setQrDataUrl(null);
      es.close();
    });

    es.addEventListener('auth_failure', () => {
      setStatus('error');
      toast.error('WhatsApp authentication failed. Try again.');
      es.close();
    });

    es.addEventListener('disconnected', () => {
      setStatus('idle');
      es.close();
    });

    es.onerror = () => {
      // SSE closed after ready/error — only show error if still pending
      setStatus((prev) => (prev === 'pending' ? 'error' : prev));
      es.close();
    };
  }

  async function disconnect() {
    setDisconnecting(true);
    try {
      esRef.current?.close();
      await fetch('/api/whatsapp/wwebjs/session', { method: 'DELETE' });
      setStatus('idle');
      setPhone(null);
      setQrDataUrl(null);
      toast.success('WhatsApp Web disconnected');
    } catch {
      toast.error('Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Card className="bg-slate-900 border-slate-700 ring-0 ring-transparent">
      <CardHeader>
        <CardTitle className="text-white flex items-center gap-2">
          <QrCode className="size-5 text-violet-400" />
          WhatsApp Web (QR Login)
        </CardTitle>
        <CardDescription className="text-slate-400">
          Connect via QR code scan — no Meta Business account required. Uses
          your personal WhatsApp number.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Status banner */}
        <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-3">
          {status === 'connected' ? (
            <CheckCircle2 className="size-4 text-violet-500 shrink-0" />
          ) : status === 'pending' ? (
            <Loader2 className="size-4 text-yellow-400 animate-spin shrink-0" />
          ) : (
            <XCircle className="size-4 text-red-500 shrink-0" />
          )}
          <span className="text-sm text-slate-300">
            {status === 'connected'
              ? `Connected${phone ? ` — +${phone}` : ''}`
              : status === 'pending'
                ? 'Waiting for QR scan…'
                : status === 'error'
                  ? 'Connection failed'
                  : 'Not connected'}
          </span>
        </div>

        {/* QR code */}
        {qrDataUrl && status === 'pending' && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-700 bg-white p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrDataUrl} alt="WhatsApp QR code" width={256} height={256} />
            <p className="text-xs text-slate-500">
              Open WhatsApp → Linked Devices → Link a Device
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          {status !== 'connected' && (
            <Button
              onClick={startQR}
              disabled={status === 'pending'}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              {status === 'pending' ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Connecting…
                </>
              ) : (
                <>
                  <QrCode className="size-4" />
                  {status === 'error' ? 'Retry' : 'Connect via QR'}
                </>
              )}
            </Button>
          )}

          {status === 'connected' && (
            <Button
              variant="outline"
              onClick={disconnect}
              disabled={disconnecting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {disconnecting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <LogOut className="size-4" />
              )}
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
