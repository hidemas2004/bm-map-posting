-- gps_tracksをタームに紐づける。記録開始時点で進行中だったタームのIDを保存する
-- （worker/gps_tracks.tsのstartTrackがサーバー側で判定）。進行中タームが無い状態で
-- 記録した場合や、タームの完了後もこの列は変更しない（タームが完了してもgps_tracksは
-- 残し続ける仕様のため）。
ALTER TABLE gps_tracks ADD COLUMN term_id INTEGER REFERENCES terms(term_id);

CREATE INDEX idx_gps_tracks_term ON gps_tracks(term_id);
