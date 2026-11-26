export interface ProjectCardAppearance {
  cardColor?: string
  cardCoverImage?: string
}

export interface ProjectMemberLike {
  id: string
  name: string
  avatarColor?: string
  avatarImage?: string
  isPool?: boolean
}

export function getHumanMembers<T extends ProjectMemberLike>(proj: {
  members: T[]
}): T[] {
  const humans = proj.members.filter((m) => !m.isPool)
  return humans.length > 0 ? humans : proj.members
}

export function getProjectCardStyle(
  proj: ProjectCardAppearance,
): Record<string, string> | undefined {
  if (proj.cardCoverImage) {
    return {
      backgroundImage: `url(${proj.cardCoverImage})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
  }
  if (proj.cardColor) {
    return {
      backgroundColor: proj.cardColor,
      backgroundImage:
        'linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(0,0,0,0.22) 100%)',
    }
  }
  return undefined
}

export function hasCustomProjectCardBg(proj: ProjectCardAppearance): boolean {
  return Boolean(proj.cardCoverImage || proj.cardColor)
}
