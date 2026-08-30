import './globals.css';

export const metadata = {
  title: 'Meridian Freight — breakdown to resolution',
  description: 'Work orders, approvals and audit trail',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="inner">
            <h1>MERIDIAN FREIGHT <span>/ breakdown to resolution</span></h1>
            <nav>
              <a href="/">Overview</a>
              <a href="/approvals">Approvals</a>
              <a href="/audit">Audit</a>
              <a href="/ask">Ask</a>
            </nav>
          </div>
        </header>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
