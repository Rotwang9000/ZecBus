/*
 * ZecBus CI/CD — https://zecbus.com
 *
 * Branch workflow (multibranch job "zecbus", source Rotwang9000/zecbus):
 *   feature/* / PRs   →  CI only (validate the static site, no deploy)
 *   main (production) →  validate → deploy to /var/www/zecbus → smoke test
 *
 * The site is plain static HTML/CSS/JS (no build step) that talks to the
 * winbit32 gateway's free /v1/zec/bus REST surface from the browser, so the
 * pipeline just validates and rsyncs `site/` into the docroot. There is no
 * separate staging vhost yet; rollback = re-run this job at the prior commit
 * (the deployed tree is exactly `site/` at that SHA).
 *
 * Deploy stages are gated `when { branch 'main' }`, which only matches when
 * BRANCH_NAME is set — i.e. in this multibranch job (a single-branch job would
 * skip them; see WINBIT32 ci/create-jenkins-jobs.sh).
 */

pipeline {
	agent any

	options {
		buildDiscarder(logRotator(numToKeepStr: '20'))
		timeout(time: 10, unit: 'MINUTES')
		timestamps()
		disableConcurrentBuilds()
	}

	environment {
		DOCROOT  = '/var/www/zecbus'
		SITE_URL = 'https://zecbus.com'
	}

	stages {

		stage('Checkout Info') {
			steps {
				sh '''
					echo "Branch:  ${BRANCH_NAME:-$GIT_BRANCH}"
					echo "Commit:  $(git rev-parse --short HEAD || echo n/a)"
				'''
			}
		}

		// ── CI: every branch / PR ─────────────────────────────
		stage('Validate') {
			steps {
				sh '''
					set -e
					for f in site/index.html site/styles.css site/app.js site/favicon.svg; do
						[ -s "$f" ] || { echo "MISSING/EMPTY: $f"; exit 1; }
					done

					# JS must parse. node is on the agent PATH (used by the other
					# pipelines); fall back to a skip if it somehow isn't.
					if command -v node >/dev/null 2>&1; then
						node --check site/app.js && echo "app.js: syntax OK"
					else
						echo "WARN: node not found — skipping JS syntax check"
					fi

					# Guard against shipping a site pinned at a stale/dev API host.
					grep -q "mcp.winbit32.com" site/app.js || { echo "app.js does not target the gateway"; exit 1; }
					echo "Validate OK"
				'''
			}
		}

		// ── PRODUCTION: main only ─────────────────────────────
		stage('Deploy → Production') {
			when { branch 'main' }
			steps {
				sh '''
					set -e
					mkdir -p "$DOCROOT"
					rsync -rl --delete --no-perms --no-group --no-owner \
						--exclude=.git site/ "$DOCROOT"/
					chmod -R a+rX "$DOCROOT"
					echo "Deployed $(git rev-parse --short HEAD) to $SITE_URL"
					ls -la "$DOCROOT"
				'''
			}
		}

		stage('Smoke Test → Production') {
			when { branch 'main' }
			steps {
				sh '''
					set -e
					code=$(curl -s -o /tmp/zecbus-smoke.html -w "%{http_code}" --max-time 20 "$SITE_URL/")
					echo "GET $SITE_URL -> $code"
					[ "$code" = "200" ] || { echo "home not 200"; exit 1; }
					grep -q "leave the Zcash pool" /tmp/zecbus-smoke.html || { echo "home marker missing"; exit 1; }
					for a in styles.css app.js favicon.svg; do
						c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$SITE_URL/$a")
						echo "  $a -> $c"
						[ "$c" = "200" ] || { echo "asset $a not 200"; exit 1; }
					done
					rm -f /tmp/zecbus-smoke.html
					echo "Smoke test passed"
				'''
			}
		}
	}

	post {
		failure { echo "ZECBUS PIPELINE FAILED — ${env.BRANCH_NAME ?: env.GIT_BRANCH} #${env.BUILD_NUMBER}" }
		success { echo "ZecBus pipeline OK — ${env.BRANCH_NAME ?: env.GIT_BRANCH} #${env.BUILD_NUMBER}" }
	}
}
