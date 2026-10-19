#!/bin/sh
# Run inside the Alpine runtime image; apk understands upstream and -r revisions.
set -eu

minimum=3.5.8-r0
# With no package arguments, apk info -v lists installed name-version records.
# With package arguments it prints descriptions instead, not version records.
if ! installed_packages=$(apk info -v); then
  echo "Cannot inspect installed Alpine packages" >&2
  exit 1
fi
for package in libcrypto3 libssl3; do
  version=$(printf '%s\n' "$installed_packages" | sed -n "s/^$package-//p")
  if [ -z "$version" ]; then
    echo "Missing installed $package" >&2
    exit 1
  fi
  if ! comparison=$(apk version -t "$version" "$minimum"); then
    echo "Cannot compare $package version $version" >&2
    exit 1
  fi
  case "$comparison" in
    '='|'>') printf '%s %s meets minimum %s\n' "$package" "$version" "$minimum" ;;
    *) echo "$package $version does not meet minimum $minimum" >&2; exit 1 ;;
  esac
done
