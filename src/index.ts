import * as core from '@actions/core'
import {getOctokit, context} from '@actions/github'
import {RestEndpointMethodTypes} from '@octokit/rest'
import {GitHub} from '@actions/github/lib/utils'
import {wait} from './utils/wait'

async function getPRDetails(
  pr: RestEndpointMethodTypes['pulls']['list']['response']['data'][number],
  client: InstanceType<typeof GitHub>
): Promise<RestEndpointMethodTypes['pulls']['get']['response']> {
  await wait(500)
  const details = await client.pulls.get({
    ...context.repo,
    pull_number: pr.number
  })

  if (details.data.mergeable !== null) {
    return details
  } else {
    return getPRDetails(pr, client)
  }
}

async function registerAction(
  pr: RestEndpointMethodTypes['pulls']['list']['response']['data'][number],
  client: InstanceType<typeof GitHub>
) {
  const {data} = await getPRDetails(pr, client)
  const requiredApprovals = parseInt(
    core.getInput('requiredApprovals') || '0',
    10
  )

  if (requiredApprovals) {
    const {data: reviews} = await client.pulls.listReviews({
      ...context.repo,
      pull_number: pr.number
    })

    const approvals = reviews.filter(review => review.state === 'APPROVED')

    if (approvals.length < requiredApprovals) {
      console.log(`PR doesn't have ${requiredApprovals} approvals.`)
      return
    }
  }

  if (data.mergeable) {
    console.log('Updating PR', pr.html_url)
    await client.pulls.updateBranch({
      ...context.repo,
      pull_number: pr.number
    })
  } else {
    console.log(
      'Not updating pull request because it has conflicts:',
      pr.html_url
    )
    core.setOutput('hasConflicts', true)
    core.setOutput(
      'conflictedPullRequestJSON',
      JSON.stringify({
        title: data.title,
        url: data.html_url,
        user: {
          login: data.user.login,
          url: data.user.html_url,
          avatarUrl: data.user.avatar_url
        }
      })
    )
  }
}

async function main() {
  const token = core.getInput('repo-token')
  const limit = parseInt(core.getInput('limit'), 10)
  const client = getOctokit(token)
  const baseBranch = context.payload.ref

  const pullsResponse = await client.pulls.list({
    ...context.repo,
    base: baseBranch,
    state: 'open'
  })

  /*
    Filter received Pull Request to get only those
    which has auto_merge enabled
   */
  const prs = (pullsResponse.data || []).filter(pr => !!pr.auto_merge)

  const branchNames = prs.map(pr => pr.head.label).join(', ')
  console.log(`Will attempt to update the following branches: ${branchNames}`)

  /*
    Get details of Pull Requests and wait
    till all of them will be executed
   */
  for (const [index, pr] of prs.entries()) {
    await registerAction(pr, client)
    if (limit && limit !== -1 && index === limit) {
      console.warn(`Limit of ${limit} pull requests hit, stopping.`)
      break
    }
  }
}

main().catch(err => {
  console.error('autoupdate-branch action failed:', err)
  process.exitCode = 1
})
