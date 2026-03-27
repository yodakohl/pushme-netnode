#!/bin/sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
image_tag="${PUSHME_NETNODE_VERIFY_IMAGE:-pushme-netnode-verify}"
image_repository="${PUSHME_NETNODE_IMAGE_REPOSITORY:-ghcr.io/yodakohl/pushme-netnode}"
version="$(tr -d '\n' < "${script_dir}/VERSION")"
base_image_ref="$(awk 'NR==1 {print $2; exit}' "${script_dir}/Dockerfile")"
build_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
published_verify_mode="${PUSHME_NETNODE_VERIFY_PUBLISHED:-1}"

inspect_published_manifest() {
  ref="$1"
  manifest_json="$(docker manifest inspect "$ref" 2>/dev/null)" || return 1
  printf '%s' "$manifest_json" | jq -c --arg ref "$ref" '
    {
      ref: $ref,
      available: true,
      mediaType: .mediaType,
      platforms: (
        [
          .manifests[]?.platform
          | select(.os != "unknown" and .architecture != "unknown")
          | .os + "/" + .architecture + (if .variant then "/" + .variant else "" end)
        ] | unique
      )
    }
  '
}

docker build -t "$image_tag" "$script_dir" >/dev/null

src_netnode_sha="$(sha256sum "${script_dir}/netnode.sh" | awk '{print $1}')"
src_setup_sha="$(sha256sum "${script_dir}/setup.sh" | awk '{print $1}')"
src_entry_sha="$(sha256sum "${script_dir}/docker-entrypoint.sh" | awk '{print $1}')"

container_hashes="$(
  docker run --rm --entrypoint sh "$image_tag" -lc '
    sha256sum /app/netnode.sh /app/setup.sh /app/docker-entrypoint.sh
  '
)"

img_netnode_sha="$(printf '%s\n' "$container_hashes" | awk '/\/app\/netnode\.sh$/ {print $1; exit}')"
img_setup_sha="$(printf '%s\n' "$container_hashes" | awk '/\/app\/setup\.sh$/ {print $1; exit}')"
img_entry_sha="$(printf '%s\n' "$container_hashes" | awk '/\/app\/docker-entrypoint\.sh$/ {print $1; exit}')"

packages_json="$(
  awk '
    /^RUN apk add --no-cache([[:space:]]|\\)/ {
      in_block = 1;
      sub(/^RUN apk add --no-cache[[:space:]]*/, "", $0);
    }
    in_block {
      continued = ($0 ~ /\\[[:space:]]*$/);
      gsub(/\\/, "", $0);
      n = split($0, parts, /[[:space:]]+/);
      for (i = 1; i <= n; i++) {
        if (parts[i] != "") {
          printf "%s\n", parts[i];
        }
      }
      if (!continued) {
        exit;
      }
    }
  ' "${script_dir}/Dockerfile" | jq -R -s 'split("\n") | map(select(length > 0))'
)"

profiles_json="$(
  awk '
    /^profile_lines\(\)/ { in_block=1; next }
    in_block && /^EOF$/ { exit }
    in_block && $0 !~ /^  cat <<\x27EOF\x27$/ {
      n = split($0, a, "|");
      if (n >= 9) {
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
          a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9];
      }
    }
  ' "${script_dir}/netnode.sh" |
    jq -R -s '
      split("\n")
      | map(select(length > 0))
      | map(split("\t"))
      | map({
          name: .[0],
          label: .[1],
          group: .[2],
          host: .[3],
          targetUrl: .[4],
          dnsHost: .[5],
          dnsProbe: (.[6] == "1"),
          providerStatus: (.[7] == "1"),
          packetProbe: (.[8] == "1")
        })
    '
)"

image_id="$(docker image inspect "$image_tag" --format '{{.Id}}')"

published_tags_json='[]'
published_all_expected_platforms='false'
if [ "$published_verify_mode" = "1" ]; then
  published_tmp="$(mktemp)"
  for tag in stable edge "$version"; do
    ref="${image_repository}:${tag}"
    if inspect_published_manifest "$ref" >>"$published_tmp"; then
      :
    else
      jq -nc --arg ref "$ref" '{ref: $ref, available: false, platforms: []}' >>"$published_tmp"
    fi
  done
  published_tags_json="$(jq -s '.' "$published_tmp")"
  published_all_expected_platforms="$(
    jq -n \
      --argjson manifests "$published_tags_json" \
      --argjson expected '["linux/amd64","linux/arm64"]' '
      ($manifests | length) == 3 and
      all($manifests[]; .available == true and (($expected - .platforms) | length == 0))
    '
  )"
  rm -f "$published_tmp"
fi

jq -n \
  --arg generatedAt "$build_date" \
  --arg imageTag "$image_tag" \
  --arg imageId "$image_id" \
  --arg imageRepository "$image_repository" \
  --arg version "$version" \
  --arg baseImage "$base_image_ref" \
  --arg publishedVerifyMode "$published_verify_mode" \
  --arg srcNetnode "$src_netnode_sha" \
  --arg srcSetup "$src_setup_sha" \
  --arg srcEntry "$src_entry_sha" \
  --arg imgNetnode "$img_netnode_sha" \
  --arg imgSetup "$img_setup_sha" \
  --arg imgEntry "$img_entry_sha" \
  --argjson packages "$packages_json" \
  --argjson profiles "$profiles_json" \
  --argjson publishedTags "$published_tags_json" \
  --argjson publishedAllExpectedPlatforms "$published_all_expected_platforms" \
  '{
    privatePreview: false,
    generatedAt: $generatedAt,
    image: {
      tag: $imageTag,
      id: $imageId,
      repository: $imageRepository,
      version: $version,
      baseImage: $baseImage
    },
    sourceDigests: {
      "netnode.sh": $srcNetnode,
      "setup.sh": $srcSetup,
      "docker-entrypoint.sh": $srcEntry
    },
    imageDigests: {
      "netnode.sh": $imgNetnode,
      "setup.sh": $imgSetup,
      "docker-entrypoint.sh": $imgEntry
    },
    sourceMatchesImage: (
      $srcNetnode == $imgNetnode and
      $srcSetup == $imgSetup and
      $srcEntry == $imgEntry
    ),
    runtime: {
      outboundOnly: true,
      publishedPorts: [],
      persistentWritePaths: ["/data"],
      ephemeralWritePaths: ["/tmp"],
      requiredDockerFlags: [
        "--read-only",
        "--tmpfs /tmp:rw,noexec,nosuid,size=8m",
        "--cap-drop ALL",
        "--cap-add NET_RAW",
        "--pids-limit 32",
        "--memory 16m",
        "--cpus 0.10"
      ]
    },
    controlPlane: {
      startupEndpoint: "POST /api/bot/netnode/startup",
      publishEndpoint: "POST /api/bot/publish",
      statusEndpoint: "GET /api/bot/netnode/status",
      auth: "Bearer API key over HTTPS"
    },
    publishedImages: {
      verificationMode: $publishedVerifyMode,
      expectedPlatforms: ["linux/amd64", "linux/arm64"],
      allExpectedPlatformsPresent: $publishedAllExpectedPlatforms,
      tags: $publishedTags
    },
    installedPackages: $packages,
    defaultProfiles: $profiles
  }'
