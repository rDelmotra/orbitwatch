import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Fuse, { type FuseResult } from 'fuse.js';
import { useStore } from '../store/useStore';
import type { EnrichedTLEObject, DeepSpaceObject, ObjectCategory } from '../data/types';

const CATEGORY_COLORS: Record<ObjectCategory, string> = {
  active_satellite: '#4CAF50',
  inactive_satellite: '#9E9E9E',
  rocket_body: '#FFC107',
  debris: '#F44336',
  unknown: '#757575',
  deep_space: '#E040FB',
};

const DEBOUNCE_MS = 150;

// A DSO result carries a flag so we know to call selectDSOByIndex instead
interface DSOResult {
  isDSO: true;
  dsoIndex: number;
  item: DeepSpaceObject;
}

type SearchResult = FuseResult<EnrichedTLEObject> | DSOResult;

function isDSOResult(r: SearchResult): r is DSOResult {
  return (r as DSOResult).isDSO === true;
}

export function SearchBar() {
  const catalogData = useStore((s) => s.catalogData);
  const selectByIndex = useStore((s) => s.selectByIndex);
  const dsoData = useStore((s) => s.dsoData);
  const selectDSOByIndex = useStore((s) => s.selectDSOByIndex);
  const loadingPhase = useStore((s) => s.loadingPhase);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);

  // Build Fuse index once when catalogData arrives
  const fuse = useMemo(() => {
    if (catalogData.length === 0) return null;
    return new Fuse(catalogData, {
      keys: [
        { name: 'name', weight: 0.7 },
        { name: 'noradId', weight: 0.3 },
      ],
      threshold: 0.4,
      getFn: (obj, path) => {
        const key = Array.isArray(path) ? path[0] : path;
        if (key === 'noradId') return String((obj as EnrichedTLEObject).noradId);
        return Fuse.config.getFn(obj, path);
      },
    });
  }, [catalogData]);

  // Debounced search
  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!value.trim() || !fuse) {
        setResults([]);
        setHighlightedIndex(0);
        return;
      }
      debounceRef.current = setTimeout(() => {
        // DSO name match (simple — there are <10)
        const lc = value.toLowerCase();
        const dsoHits: DSOResult[] = dsoData
          .map((dso, i) => ({ isDSO: true as const, dsoIndex: i, item: dso }))
          .filter(({ item }) =>
            item.name.toLowerCase().includes(lc) ||
            (item.mission ?? '').toLowerCase().includes(lc)
          );

        const tleHits = fuse.search(value, { limit: 10 - dsoHits.length });
        setResults([...dsoHits, ...tleHits]);
        setHighlightedIndex(0);
      }, DEBOUNCE_MS);
    },
    [fuse, dsoData],
  );

  // Select a result
  const selectResult = useCallback(
    (result: SearchResult) => {
      if (isDSOResult(result)) {
        selectDSOByIndex?.(result.dsoIndex);
      } else if (result.refIndex != null) {
        selectByIndex?.(result.refIndex);
      }
      setQuery('');
      setResults([]);
      setIsOpen(false);
      inputRef.current?.blur();
    },
    [selectByIndex, selectDSOByIndex],
  );

  // Keyboard navigation
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && results.length > 0) {
        e.preventDefault();
        const hit = results[highlightedIndex];
        if (hit) selectResult(hit);
      } else if (e.key === 'Escape') {
        setQuery('');
        setResults([]);
        setIsOpen(false);
        inputRef.current?.blur();
      }
    },
    [results, highlightedIndex, selectResult],
  );

  // "/" global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === '/') {
        e.preventDefault();
        inputRef.current?.focus();
        setIsOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setResults([]);
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (loadingPhase !== 'ready') return null;

  const showDropdown = isOpen && results.length > 0;

  return (
    <div ref={containerRef} style={containerStyle}>
      <div style={inputWrapperStyle}>
        <span style={iconStyle}>&#x2315;</span>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search satellites...  (/)"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => setIsOpen(true)}
          onKeyDown={onKeyDown}
          style={inputStyle}
        />
      </div>
      {showDropdown && (
        <div style={dropdownStyle}>
          {results.map((hit, i) => {
            const isDSO = isDSOResult(hit);
            const name = isDSO ? hit.item.name : hit.item.name;
            const dotColor = isDSO
              ? CATEGORY_COLORS['deep_space']
              : CATEGORY_COLORS[(hit.item as EnrichedTLEObject).category as ObjectCategory];
            const key = isDSO ? `dso-${hit.dsoIndex}` : String((hit.item as EnrichedTLEObject).noradId);
            const secondary = isDSO
              ? (hit.item.mission ?? 'Deep Space')
              : String((hit.item as EnrichedTLEObject).noradId);

            return (
              <div
                key={key}
                style={{
                  ...resultItemStyle,
                  background: i === highlightedIndex ? 'rgba(255,255,255,0.08)' : 'transparent',
                }}
                onMouseEnter={() => setHighlightedIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectResult(hit);
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: dotColor,
                    marginRight: 8,
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {name}
                </span>
                <span style={{ color: 'rgba(255,255,255,0.35)', marginLeft: 8, flexShrink: 0 }}>
                  {secondary}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  width: 320,
  pointerEvents: 'auto',
  zIndex: 10,
};

const inputWrapperStyle: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
};

const iconStyle: React.CSSProperties = {
  position: 'absolute',
  left: 10,
  color: 'rgba(255,255,255,0.35)',
  fontSize: '14px',
  pointerEvents: 'none',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px 8px 30px',
  background: 'rgba(0, 0, 0, 0.7)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
  fontFamily: 'monospace',
  fontSize: '12px',
  color: 'rgba(255, 255, 255, 0.85)',
  outline: 'none',
};

const dropdownStyle: React.CSSProperties = {
  marginTop: 4,
  background: 'rgba(0, 0, 0, 0.85)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
  overflow: 'hidden',
  maxHeight: 360,
};

const resultItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '7px 12px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: '12px',
  color: 'rgba(255, 255, 255, 0.85)',
};
