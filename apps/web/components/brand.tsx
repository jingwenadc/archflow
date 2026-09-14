export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand-lockup" aria-label="图策 ArchFlow">
      <svg className="brand-symbol" viewBox="0 0 64 64" role="img" aria-hidden="true">
        <path className="brand-block brand-block-dark" d="M29 7 43 15 29 23 15 15Z" />
        <path className="brand-block brand-block-mid" d="M11 21 25 29 25 45 11 37Z" />
        <path className="brand-block brand-block-dark" d="M39 29 53 21 53 37 39 45Z" />
        <path className="brand-block brand-block-accent" d="M28 27 36 31.5 36 49 28 53.5Z" />
        <path className="brand-block brand-block-accent" d="M29 26 37 21.5 44 25.5 36 30Z" />
      </svg>
      {!compact && (
        <span className="brand-type">
          <strong>图策</strong>
          <span>ArchFlow</span>
        </span>
      )}
    </span>
  );
}
