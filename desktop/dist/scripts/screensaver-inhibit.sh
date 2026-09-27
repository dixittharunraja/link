#!/bin/bash
exec systemd-inhibit --what=idle --why=Link --who=Link sleep infinity
