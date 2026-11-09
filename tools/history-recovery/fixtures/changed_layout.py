"""BASE_WHERE lost a documented marker."""

BASE_WHERE = """
"instanceId" = (select id from "Instance" where name = %s)
AND coalesce(key->>'fromMe','false') = 'false'
"""


def candidate_ids(since):
    return BASE_WHERE


def fetch_rows(keyids):
    sql = """
    SELECT id FROM "Message"
    WHERE "instanceId" = %s AND key->>'id' IN %s
    """
    return sql
