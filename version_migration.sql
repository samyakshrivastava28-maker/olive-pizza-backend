CREATE TABLE IF NOT EXISTS app_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_string TEXT NOT NULL,
    build_number INTEGER NOT NULL,
    release_notes TEXT,
    features JSONB DEFAULT '[]',
    bug_fixes JSONB DEFAULT '[]',
    status TEXT DEFAULT 'draft',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_update_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    latest_version TEXT NOT NULL,
    minimum_version TEXT NOT NULL,
    update_mode TEXT DEFAULT 'optional',
    maintenance_mode BOOLEAN DEFAULT false,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO app_update_settings (id, latest_version, minimum_version, update_mode, maintenance_mode)
VALUES (1, '1.0.0', '1.0.0', 'optional', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_versions (version_string, build_number, release_notes, status)
VALUES ('1.0.0', 1, 'Initial Release', 'published')
ON CONFLICT DO NOTHING;
