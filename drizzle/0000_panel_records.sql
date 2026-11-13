CREATE TABLE panel_records (
  owner TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0)
);
