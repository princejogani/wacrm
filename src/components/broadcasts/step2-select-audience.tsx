'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Users,
  Tags,
  Filter,
  Upload,
  Loader2,
  ArrowRight,
  ArrowLeft,
  X,
  FileText,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';

type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv';
type CustomFieldOperator = 'is' | 'is_not' | 'contains';

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

const audienceOptions: {
  type: AudienceType;
  label: string;
  description: string;
  icon: typeof Users;
}[] = [
  {
    type: 'all',
    label: 'All Contacts',
    description: 'Send to every contact in your database',
    icon: Users,
  },
  {
    type: 'tags',
    label: 'Filter by Tags',
    description: 'Target contacts with specific tags',
    icon: Tags,
  },
  {
    type: 'custom_field',
    label: 'Custom Field',
    description: 'Filter by a custom field value',
    icon: Filter,
  },
  {
    type: 'csv',
    label: 'Upload CSV',
    description: 'Upload a list of phone numbers',
    icon: Upload,
  },
];

const OPERATOR_OPTIONS: { value: CustomFieldOperator; label: string }[] = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'contains', label: 'contains' },
];

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function parseCsv(text: string): { phone: string; name?: string }[] {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return [];

    // Detect header row
    const firstLower = lines[0].toLowerCase();
    const hasHeader = firstLower.includes('phone') || firstLower.includes('name') || firstLower.includes('mobile');
    const dataLines = hasHeader ? lines.slice(1) : lines;

    // Detect delimiter
    const delim = lines[0].includes('\t') ? '\t' : ',';

    // Detect column positions from header or assume phone=0, name=1
    let phoneCol = 0;
    let nameCol = 1;
    if (hasHeader) {
      const headers = lines[0].split(delim).map((h) => h.trim().toLowerCase().replace(/["']/g, ''));
      const pi = headers.findIndex((h) => h.includes('phone') || h.includes('mobile') || h.includes('number'));
      const ni = headers.findIndex((h) => h.includes('name'));
      if (pi !== -1) phoneCol = pi;
      if (ni !== -1) nameCol = ni;
    }

    const results: { phone: string; name?: string }[] = [];
    for (const line of dataLines) {
      const cols = line.split(delim).map((c) => c.trim().replace(/^["']|["']$/g, ''));
      const rawPhone = cols[phoneCol]?.trim();
      if (!rawPhone) continue;
      // Normalize: keep digits and leading +
      const phone = rawPhone.startsWith('+') ? '+' + rawPhone.slice(1).replace(/\D/g, '') : rawPhone.replace(/\D/g, '');
      if (phone.replace(/\D/g, '').length < 7) continue; // skip invalid
      const name = cols[nameCol]?.trim() || undefined;
      results.push({ phone, name });
    }
    return results;
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCsvError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.csv') && !file.name.endsWith('.txt') && file.type !== 'text/plain') {
      setCsvError('Please upload a .csv file');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const contacts = parseCsv(text);
      if (contacts.length === 0) {
        setCsvError('No valid phone numbers found in the file');
        return;
      }
      onUpdate({ ...audience, type: 'csv', csvContacts: contacts });
    };
    reader.readAsText(file);
    // Reset input so same file can be re-uploaded
    e.target.value = '';
  }

  // Tags are used both by the primary "Filter by Tags" audience type
  // AND by the exclude-list below — so always load once on mount.
  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);
      try {
        const supabase = createClient();
        const { data } = await supabase.from('tags').select('*').order('name');
        setTags(data ?? []);
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTags();
  }, []);

  // Lazy-load custom fields only when that audience type is active.
  useEffect(() => {
    if (audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [audience.type]);

  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      const supabase = createClient();

      // Base query — produces the superset before exclude is applied.
      let baseIds: Set<string> | null = null; // null means "all contacts"

      if (audience.type === 'all') {
        // Handled below — full-table count adjusted by excludes.
      } else if (
        audience.type === 'tags' &&
        audience.tagIds &&
        audience.tagIds.length > 0
      ) {
        const { data } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.tagIds);
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'custom_field' &&
        audience.customField?.fieldId &&
        audience.customField.value
      ) {
        const { fieldId, operator, value } = audience.customField;
        let q = supabase
          .from('contact_custom_values')
          .select('contact_id')
          .eq('custom_field_id', fieldId);
        if (operator === 'is') q = q.eq('value', value);
        else if (operator === 'is_not') q = q.neq('value', value);
        else q = q.ilike('value', `%${value}%`);
        const { data } = await q;
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'csv' &&
        audience.csvContacts &&
        audience.csvContacts.length > 0
      ) {
        setEstimatedCount(audience.csvContacts.length);
        return;
      } else {
        // Partially-configured audience — wait for the user to finish.
        setEstimatedCount(null);
        return;
      }

      // Apply exclude tags
      let excludeSet: Set<string> | null = null;
      if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
        const { data: excludeRows } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.excludeTagIds);
        excludeSet = new Set((excludeRows ?? []).map((r) => r.contact_id));
      }

      if (baseIds) {
        const effective = [...baseIds].filter(
          (id) => !excludeSet?.has(id),
        );
        setEstimatedCount(effective.length);
      } else {
        // "All" — fetch the total, then subtract exclude set if any.
        const { count } = await supabase
          .from('contacts')
          .select('*', { count: 'exact', head: true });
        const total = count ?? 0;
        setEstimatedCount(excludeSet ? Math.max(0, total - excludeSet.size) : total);
      }
    } finally {
      setLoadingCount(false);
    }
  }, [
    audience.type,
    audience.tagIds,
    audience.customField,
    audience.csvContacts,
    audience.excludeTagIds,
  ]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, tagIds: updated });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, excludeTagIds: updated });
  }

  function updateCustomField(patch: Partial<CustomFieldFilter>) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };
    onUpdate({ ...audience, customField: { ...prev, ...patch } });
  }

  const isValid =
    audience.type === 'all' ||
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    (audience.type === 'custom_field' &&
      !!audience.customField?.fieldId &&
      audience.customField.value.length > 0) ||
    (audience.type === 'csv' &&
      audience.csvContacts &&
      audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Select Audience</h2>
        <p className="mt-1 text-sm text-slate-400">
          Choose who will receive this broadcast.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {audienceOptions.map((option) => {
          const isSelected = audience.type === option.type;
          const Icon = option.icon;
          return (
            <button
              key={option.type}
              onClick={() =>
                onUpdate({
                  ...audience,
                  type: option.type,
                  // Wipe shape fields from other types to avoid stale
                  // config leaking across selections.
                  tagIds: option.type === 'tags' ? audience.tagIds : undefined,
                  customField:
                    option.type === 'custom_field'
                      ? audience.customField
                      : undefined,
                  csvContacts:
                    option.type === 'csv' ? audience.csvContacts : undefined,
                })
              }
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                isSelected
                  ? 'border-violet-500 bg-violet-500/5 ring-1 ring-violet-500/30'
                  : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
              }`}
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  isSelected
                    ? 'bg-violet-500/10 text-violet-400'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-white">{option.label}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {option.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {audience.type === 'tags' && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <p className="mb-3 text-sm font-medium text-white">Select Tags</p>
          {loadingTags ? (
            <Loader2 className="h-5 w-5 animate-spin text-violet-500" />
          ) : tags.length === 0 ? (
            <p className="text-xs text-slate-400">
              No tags found. Create tags in Settings.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = audience.tagIds?.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                      isSelected
                        ? 'border-violet-500/30 bg-violet-500/10 text-violet-400'
                        : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <span
                      className="mr-1.5 h-2 w-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {audience.type === 'custom_field' && (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <p className="text-sm font-medium text-white">Custom Field Filter</p>
          {loadingFields ? (
            <Loader2 className="h-5 w-5 animate-spin text-violet-500" />
          ) : customFields.length === 0 ? (
            <p className="text-xs text-slate-400">
              No custom fields defined. Create one in Settings → Custom Fields.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                value={audience.customField?.fieldId ?? ''}
                onChange={(e) => updateCustomField({ fieldId: e.target.value })}
                className="h-9 rounded-lg border border-slate-700 bg-slate-800 px-2.5 text-sm text-white outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
              >
                <option value="">Select field…</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                value={audience.customField?.operator ?? 'is'}
                onChange={(e) =>
                  updateCustomField({
                    operator: e.target.value as CustomFieldOperator,
                  })
                }
                className="h-9 rounded-lg border border-slate-700 bg-slate-800 px-2.5 text-sm text-white outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
              >
                {OPERATOR_OPTIONS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={audience.customField?.value ?? ''}
                onChange={(e) => updateCustomField({ value: e.target.value })}
                placeholder="Value"
                className="h-9 rounded-lg border border-slate-700 bg-slate-800 px-2.5 text-sm text-white outline-none placeholder:text-slate-500 focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
              />
            </div>
          )}
        </div>
      )}

      {/* CSV Upload */}
      {audience.type === 'csv' && (
        <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <p className="text-sm font-medium text-white">Upload CSV File</p>

          {/* Format guide */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
            <p className="mb-2 text-xs font-medium text-slate-300">Required CSV format:</p>
            <pre className="text-[11px] text-slate-400 leading-relaxed">{`phone,name
+919876543210,John Doe
+14155552671,Jane Smith
919876543211,Rahul`}</pre>
            <p className="mt-2 text-[11px] text-slate-500">
              • First column: phone number (with or without +, country code required)<br />
              • Second column: name (optional)<br />
              • Header row optional — auto-detected<br />
              • Comma or tab separated
            </p>
          </div>

          {/* Upload area */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-700 bg-slate-900 py-8 transition-colors hover:border-violet-500/50 hover:bg-violet-500/5"
          >
            <Upload className="h-8 w-8 text-slate-500" />
            <p className="text-sm font-medium text-slate-300">Click to upload CSV</p>
            <p className="text-xs text-slate-500">.csv files only</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>

          {/* Error */}
          {csvError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
              <p className="text-xs text-red-300">{csvError}</p>
            </div>
          )}

          {/* Loaded contacts preview */}
          {audience.csvContacts && audience.csvContacts.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-violet-400" />
                <p className="text-sm font-medium text-white">
                  {audience.csvContacts.length.toLocaleString()} contacts loaded
                </p>
                <button
                  onClick={() => onUpdate({ ...audience, csvContacts: [] })}
                  className="ml-auto text-xs text-slate-500 hover:text-red-400"
                >
                  Clear
                </button>
              </div>
              {/* Preview first 5 rows */}
              <div className="overflow-hidden rounded-lg border border-slate-700">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700 bg-slate-800">
                      <th className="px-3 py-2 text-left font-medium text-slate-400">#</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-400">Phone</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-400">Name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audience.csvContacts.slice(0, 5).map((c, i) => (
                      <tr key={i} className="border-b border-slate-800 last:border-0">
                        <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-2 font-mono text-slate-300">{c.phone}</td>
                        <td className="px-3 py-2 text-slate-400">{c.name ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {audience.csvContacts.length > 5 && (
                  <p className="px-3 py-2 text-center text-xs text-slate-500">
                    +{audience.csvContacts.length - 5} more
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Empty state */}
          {(!audience.csvContacts || audience.csvContacts.length === 0) && !csvError && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <FileText className="h-4 w-4" />
              No file uploaded yet
            </div>
          )}
        </div>
      )}

      {/* Exclude list — applies regardless of audience type */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <X className="h-4 w-4 text-red-400" />
          <p className="text-sm font-medium text-white">
            Exclude contacts with these tags
          </p>
          <span className="text-xs text-slate-500">(optional)</span>
        </div>
        {tags.length === 0 ? (
          <p className="text-xs text-slate-500">No tags available.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isExcluded = audience.excludeTagIds?.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleExcludeTag(tag.id)}
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                    isExcluded
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  <span
                    className="mr-1.5 h-2 w-2 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Audience Summary */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <p className="mb-2 text-sm font-medium text-white">Audience Summary</p>
        {loadingCount ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
            <span className="text-xs text-slate-400">Calculating…</span>
          </div>
        ) : estimatedCount !== null ? (
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-violet-400" />
            <span className="text-sm text-white">
              {estimatedCount.toLocaleString()}
            </span>
            <span className="text-xs text-slate-400">estimated recipients</span>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            Select an audience type to see the estimate.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-slate-800 pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-slate-700 text-slate-300"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <Button
          onClick={onNext}
          disabled={!isValid}
          className="bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
