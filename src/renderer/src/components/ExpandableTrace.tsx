import { memo, useId, useState, type CSSProperties, type ReactNode } from "react";

export type ExpandableTraceKind = "steps" | "reasoning" | "search" | "coding";
export type ExpandableTraceTone = "working" | "success" | "attention" | "error" | "neutral";

export type ExpandableTraceRow = {
  id: string;
  primary: string;
  secondary?: string;
  trailing?: string;
  href?: string;
  mono?: boolean;
  add?: number;
  del?: number;
};

type ExpandableTraceProps = {
  kind: ExpandableTraceKind;
  active: boolean;
  activeLabel: string;
  settledLabel: string;
  tone: ExpandableTraceTone;
  rows: ExpandableTraceRow[];
  autoExpanded: boolean;
  children?: ReactNode;
  className?: string;
  testId?: string;
};

function SparkleIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 2 2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2Z" />
    </svg>
  );
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function TraceRowMarker({ active, tone }: { active: boolean; tone: ExpandableTraceTone }): React.JSX.Element {
  if (active) return <span className="expandable-trace-spinner" aria-hidden="true" />;
  if (tone === "error") {
    return (
      <svg className="expandable-trace-row-marker trace-marker-error" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 7v6M12 17h.01" />
      </svg>
    );
  }
  if (tone === "attention") {
    return (
      <svg className="expandable-trace-row-marker trace-marker-attention" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l3 2" />
      </svg>
    );
  }
  return (
    <svg className="expandable-trace-row-marker" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

export const ExpandableTrace = memo(function ExpandableTrace({
  kind,
  active,
  activeLabel,
  settledLabel,
  tone,
  rows,
  autoExpanded,
  children,
  className,
  testId,
}: ExpandableTraceProps): React.JSX.Element {
  const contentId = useId();
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? autoExpanded;
  const label = active ? activeLabel : settledLabel;

  return (
    <section
      className={`expandable-trace trace-tone-${tone}${className ? ` ${className}` : ""}`}
      data-trace-kind={kind}
      data-trace-state={active ? "active" : "settled"}
      data-testid={testId}
    >
      <button
        type="button"
        className="expandable-trace-header"
        aria-controls={contentId}
        aria-expanded={expanded}
        onClick={() => setManualExpanded((current) => !(current ?? autoExpanded))}
      >
        <span className="expandable-trace-icon"><SparkleIcon /></span>
        <span className={`expandable-trace-label${active ? " is-active" : ""}`} role="status">{label}</span>
        <span className={`expandable-trace-chevron${expanded ? " is-expanded" : ""}`}><ChevronIcon /></span>
      </button>

      <div
        className={`expandable-trace-collapse${expanded ? " is-expanded" : ""}`}
        id={contentId}
        aria-hidden={!expanded}
      >
        <div className="expandable-trace-clip">
          <div className="expandable-trace-tree">
            <span className="expandable-trace-line" aria-hidden="true" />
            <div className="expandable-trace-rows">
              {rows.map((row, index) => {
                const content = (
                  <>
                    <TraceRowMarker active={active && index === rows.length - 1} tone={tone} />
                    <span className="expandable-trace-row-copy">
                      <span className="expandable-trace-row-primary">{row.primary}</span>
                      {row.secondary ? <span className={row.mono ? "is-mono" : undefined}>{row.secondary}</span> : null}
                    </span>
                    {row.add !== undefined ? (
                      <span className="expandable-trace-diff">
                        <span>+{row.add}</span>
                        <span>−{row.del ?? 0}</span>
                      </span>
                    ) : null}
                    {row.trailing ? <span className="expandable-trace-row-trailing">{row.trailing}</span> : null}
                  </>
                );
                const style = { "--trace-row-delay": `${index * 70}ms` } as CSSProperties;
                const rowClassName = "expandable-trace-row";
                return row.href ? (
                  <a
                    className={rowClassName}
                    href={row.href}
                    key={row.id}
                    rel="noreferrer noopener"
                    style={style}
                    target="_blank"
                  >
                    {content}
                  </a>
                ) : (
                  <div className={rowClassName} key={row.id} style={style}>{content}</div>
                );
              })}
              {children ? <div className="expandable-trace-details">{children}</div> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
});
