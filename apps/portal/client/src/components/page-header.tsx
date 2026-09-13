interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <div className="px-5 md:px-8 pt-6 md:pt-8 pb-4 md:pb-6 border-b border-border bg-background">
      <div className="max-w-6xl mx-auto flex flex-col gap-3 md:gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-primary mb-1.5">
              {eyebrow}
            </div>
          )}
          <h1 className="text-xl md:text-xl font-semibold tracking-tight" data-testid="text-page-title">
            {title}
          </h1>
          {description && (
            <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}

export function PageBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 md:px-8 py-5 md:py-8">
      <div className="max-w-6xl mx-auto">{children}</div>
    </div>
  );
}
