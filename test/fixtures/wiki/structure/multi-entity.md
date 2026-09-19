# Decisions

<!-- mex:entity
id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD
type: decision
status: promoted
revision: 1
-->
## Rotate refresh tokens

Refresh tokens are single-use and rotated after every successful refresh.

<!-- mex:entity
id: mx_01BX5ZZKBKACTAV9WEVGEMMVRZ
type: decision
status: in_flight
revision: 1
-->
## Cache session lookups

Session lookups hit Redis before the database.
