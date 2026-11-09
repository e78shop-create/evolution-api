"""Synthetic watcher shape. No live identifiers."""

INTERVAL = 30
SKIP_TYPES = ("stub", "protocol")


BASE_WHERE = """
"instanceId" = (select id from "Instance" where name = %s)
AND "messageTimestamp" >= %s
AND coalesce(key->>'fromMe','false') = 'false'
AND (remoteJid matches user/lid/allowed-group patterns)
AND "messageType" NOT IN %s
"""


def candidate_ids(since):
    sql = "SELECT id FROM \"Message\" WHERE " + BASE_WHERE
    return sql, since


def fetch_rows(keyids):
    sql = """
    SELECT id, status, message
    FROM "Message"
    WHERE "instanceId" = %s
      AND key->>'id' IN %s
    """
    return sql, keyids
