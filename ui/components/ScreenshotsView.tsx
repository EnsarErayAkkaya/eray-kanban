import type { Screenshot } from '@shared/screenshot';

const SIZE_LABEL: Readonly<Record<Screenshot['size'], string>> = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };

interface Props {
  readonly shots: readonly Screenshot[];
  readonly imageUrl: (id: number) => string;
  readonly onOpen: (shot: Screenshot) => void;
}

// One row per route, one tile per size, in the order they were taken.
export function ScreenshotsView({ shots, imageUrl, onOpen }: Props) {
  const routes = [...new Set(shots.map((s) => s.route))];
  return (
    <div className="shots">
      {routes.map((route) => (
        <div key={route} className="shots__route">
          <code className="shots__path">{route}</code>
          <div className="shots__row">
            {shots
              .filter((s) => s.route === route)
              .map((s) => (
                <figure key={s.id} className={`shots__tile shots__tile--${s.size}`}>
                  {s.hasImage ? (
                    <button type="button" className="shots__thumb" onClick={() => onOpen(s)} aria-label={`Open ${route} at ${s.size} size`}>
                      <img src={imageUrl(s.id)} alt={`${route} at ${s.width}px`} loading="lazy" />
                    </button>
                  ) : (
                    <div className="shots__missing">No image</div>
                  )}
                  <figcaption>
                    {SIZE_LABEL[s.size]} · {s.width}px
                    {s.error && <div className="card__error">{s.error}</div>}
                  </figcaption>
                </figure>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface LightboxProps {
  readonly shot: Screenshot;
  readonly imageUrl: (id: number) => string;
  readonly onClose: () => void;
}

export function ScreenshotLightbox({ shot, imageUrl, onClose }: LightboxProps) {
  return (
    <div className="lightbox" role="dialog" aria-label={`Screenshot of ${shot.route}`} onClick={onClose}>
      <div className="lightbox__bar">
        <code>{shot.route}</code> · {SIZE_LABEL[shot.size]} {shot.width}px
        <button className="btn btn--small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="lightbox__body">
        <img src={imageUrl(shot.id)} alt={`${shot.route} at ${shot.width}px`} style={{ width: shot.width }} onClick={(e) => e.stopPropagation()} />
      </div>
    </div>
  );
}
