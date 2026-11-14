import { useEffect, useState } from 'react';
import { fetchPrivateImageBlobUrl } from '../api';

interface PrivateImageProps {
  fileId: string;
  alt: string;
  initData?: string;
  adminToken?: string;
  adminKey?: string;
  className?: string;
}

export function PrivateImage({ fileId, alt, initData, adminToken, adminKey, className = '' }: PrivateImageProps) {
  const [src, setSrc] = useState<string>('');
  const [err, setErr] = useState<string>('');

  useEffect(() => {
    let active = true;
    let createdUrl = '';
    setErr('');
    setSrc('');

    fetchPrivateImageBlobUrl(fileId, { initData, adminToken, adminKey })
      .then((url) => {
        createdUrl = url;
        if (active) setSrc(url);
        else URL.revokeObjectURL(url);
      })
      .catch((e) => {
        if (active) setErr(e?.message || 'Failed to load image');
      });

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [fileId, initData, adminToken, adminKey]);

  if (err) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 text-xs text-slate-500 p-3 rounded-lg border border-slate-200 ${className}`}>
        {err}
      </div>
    );
  }

  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 text-xs text-slate-400 p-3 rounded-lg border border-slate-200 ${className}`}>
        Loading image...
      </div>
    );
  }

  return <img src={src} alt={alt} referrerPolicy="no-referrer" className={`rounded-lg border border-slate-200 object-cover ${className}`} />;
}
