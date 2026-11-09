import { JourneyHeader } from "./_journey/journey-header";

export default function NotFound() {
  return (
    <>
      <JourneyHeader current="start" />
      <main className="wrap" id="main">
        <section className="card" aria-labelledby="nf-h">
          <div className="card__head">
            <h1 id="nf-h">That page does not exist</h1>
          </div>
          <p>
            The address may be mistyped or from an older version. The journey has nine steps; the
            bar above links to each of them.
          </p>
          <p>
            <a className="btn btn--primary" href="/">
              Back to the start
            </a>
          </p>
        </section>
      </main>
    </>
  );
}
